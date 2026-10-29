import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import http2, { type ClientHttp2Session, type ClientHttp2Stream, type Http2Session, type ServerHttp2Stream } from "node:http2";
import net, { type AddressInfo, type Socket } from "node:net";
import test from "node:test";
import { bridge } from "../../src/federation/transport.js";

const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
async function listen(server: net.Server | http2.Http2Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("resource cleanup timed out");
    await wait(5);
  }
}

type ResponseMode = "response" | "half-close" | "fin" | "reset" | "cancel" | "cancel-draining";
interface ResponseOptions { mode?: ResponseMode; bytes?: number; window?: number; slow?: boolean; }

async function responseThroughBridge(options: ResponseOptions = {}) {
  const mode = options.mode ?? "response";
  const coreSockets = new Set<Socket>(), relaySockets = new Set<Socket>(), sessions = new Set<Http2Session>();
  const sourceClosed = deferred(), relayClosed = deferred(), clientClosed = deferred(), responseEnded = deferred();
  const chunks: Buffer[] = [];
  let client: ClientHttp2Session | undefined, request: ClientHttp2Stream | undefined, relay: ServerHttp2Stream | undefined;
  let sourceFinished = false, pendingAtSourceClose = 0, finishListenersAfterCancel: number | undefined;
  const body = Buffer.alloc(options.bytes ?? 22_161, "x");
  Buffer.from("data: ").copy(body); Buffer.from("\n\n").copy(body, body.length - 2);
  const expected = Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`), body]);
  // A half-open TCP peer replies after request-side EOF. The HTTP server's own
  // automatic close-on-FIN policy must not decide this bridge half-close test.
  const core = mode === "half-close" ? net.createServer({ allowHalfOpen: true }, socket => {
    socket.on("data", () => {});
    socket.on("end", () => socket.end(expected, () => { sourceFinished = true; }));
  }) : http.createServer((incoming, outgoing) => {
    incoming.resume();
    if (mode === "fin") { incoming.socket.destroy(); return; }
    if (mode === "reset") { incoming.socket.resetAndDestroy(); return; }
    if (mode === "cancel") return;
    outgoing.sendDate = false;
    outgoing.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": body.length, Connection: "close" });
    outgoing.on("finish", () => { sourceFinished = true; });
    outgoing.end(body);
  });
  core.on("connection", socket => {
    coreSockets.add(socket); socket.on("error", () => {}); socket.on("close", () => coreSockets.delete(socket));
  });
  const gateway = http2.createServer();
  gateway.on("session", session => {
    sessions.add(session); session.on("error", () => {}); session.on("close", () => sessions.delete(session));
  });
  let upstreamPort = 0;
  gateway.on("stream", stream => {
    relay = stream; stream.on("error", () => {}); stream.respond({ ":status": 200 });
    const socket = net.createConnection({ host: "127.0.0.1", port: upstreamPort });
    relaySockets.add(socket); socket.on("error", () => {});
    socket.on("close", () => {
      pendingAtSourceClose = stream.writableLength;
      relaySockets.delete(socket); sourceClosed.resolve();
    });
    stream.on("close", relayClosed.resolve);
    bridge(stream, socket);
  });
  try {
    upstreamPort = await listen(core);
    const port = await listen(gateway);
    client = http2.connect(`http://127.0.0.1:${port}`, { settings: { initialWindowSize: options.window ?? 65_535 } });
    client.on("error", () => {});
    await within(new Promise<void>(resolve => client!.once("remoteSettings", () => resolve())), "HTTP/2 settings");
    request = client.request({ ":method": "POST", ":path": "/bridge" }, { endStream: false });
    request.on("error", () => {}); request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", responseEnded.resolve); request.on("close", clientClosed.resolve);
    if (options.slow) request.pause();
    request.write("GET /fixture HTTP/1.1\r\nHost: fixture.invalid\r\nConnection: close\r\n\r\n");
    if (mode === "half-close") request.end();
    if (mode === "cancel") {
      await until(() => Boolean(relay && coreSockets.size));
      request.end(); request.close(http2.constants.NGHTTP2_CANCEL);
    } else if (mode === "cancel-draining") {
      await within(sourceClosed.promise, "normal source close");
      assert.ok(relay && relay.writableLength > 0, "the destination must still have actual flow-controlled bytes");
      assert.equal(relay.writableFinished, false);
      assert.ok(relay.listenerCount("finish") > 0);
      request.close(http2.constants.NGHTTP2_CANCEL);
      await within(relayClosed.promise, "cancel while draining");
      await wait(0);
      finishListenersAfterCancel = relay.listenerCount("finish");
    } else if (mode !== "fin" && mode !== "reset") {
      if (options.slow) {
        if (body.length < 64 * 1024) await within(sourceClosed.promise, "source EOF while client paused");
        else await wait(30);
        request.resume();
      }
      await within(Promise.race([responseEnded.promise, clientClosed.promise]), "response end");
      if (!request.writableEnded) request.end();
    }
    await within(Promise.all([sourceClosed.promise, relayClosed.promise, clientClosed.promise]), "bridge close");
    await until(() => coreSockets.size === 0 && relaySockets.size === 0);
    const actual = Buffer.concat(chunks), bodyOffset = actual.indexOf("\r\n\r\n") + 4;
    return { expected, actual, body, actualBody: actual.subarray(bodyOffset), sourceFinished, pendingAtSourceClose,
      finishListenersAfterCancel, rstCode: relay?.rstCode };
  } finally {
    request?.destroy(); client?.destroy();
    for (const session of sessions) session.destroy();
    for (const socket of relaySockets) socket.destroy();
    for (const socket of coreSockets) socket.destroy();
    await Promise.all([new Promise<void>(resolve => core.close(() => resolve())), new Promise<void>(resolve => gateway.close(() => resolve()))]);
  }
}

const responseCases: Array<[string, ResponseOptions]> = [
  ["short response", { bytes: 1024 }],
  ["22 KiB response", {}],
  ["small-window slow reader", { slow: true, window: 1024 }],
  ["large slow response tail", { slow: true, window: 16_384, bytes: 262_144 }],
  ["request half-close before response", { mode: "half-close" }],
];
for (const [name, options] of responseCases) {
  test(`bridge preserves every byte and SHA-256: ${name}`, { timeout: 10_000 }, async () => {
    const result = await responseThroughBridge(options);
    assert.equal(result.sourceFinished, true);
    if (options.slow) assert.ok(result.pendingAtSourceClose > 0, "exercise actual buffered bytes at source close");
    assert.equal(result.actual.length, result.expected.length);
    assert.equal(hash(result.actual), hash(result.expected));
    assert.equal(hash(result.actualBody), hash(result.body));
  });
}

for (const mode of ["fin", "reset", "cancel"] as const) {
  test(`bridge promptly closes both endpoints after ${mode}`, { timeout: 10_000 }, async () => {
    const result = await responseThroughBridge({ mode });
    assert.equal(result.sourceFinished, false);
    assert.equal(result.actual.length, 0);
    if (mode === "cancel") assert.equal(result.rstCode, http2.constants.NGHTTP2_CANCEL);
  });
}

test("bridge cancels a pending normal-close drain and removes its finish observer", { timeout: 10_000 }, async () => {
  const result = await responseThroughBridge({ mode: "cancel-draining", window: 1024, slow: true });
  assert.equal(result.sourceFinished, true);
  assert.ok(result.pendingAtSourceClose > 0);
  assert.equal(result.rstCode, http2.constants.NGHTTP2_CANCEL);
  assert.equal(result.finishListenersAfterCancel, 0);
});

test("HTTP/2 CANCEL after input EOF does not wait for a backpressured upload destination", { timeout: 10_000 }, async () => {
  const sessions = new Set<Http2Session>(), streams = new Set<ServerHttp2Stream | ClientHttp2Stream>();
  const incomingEnd = deferred(), incomingClose = deferred(), outgoingClose = deferred(), clientClose = deferred();
  let incoming: ServerHttp2Stream | undefined, outgoing: ClientHttp2Stream | undefined, upstream: ServerHttp2Stream | undefined;
  let upstreamSession: ClientHttp2Session | undefined, client: ClientHttp2Session | undefined, request: ClientHttp2Stream | undefined;
  let stateAtCancel: { ended: boolean; finished: boolean; errored: boolean; reset: number; pending: number } | undefined;
  const core = http2.createServer({ settings: { initialWindowSize: 1024 } }), gateway = http2.createServer();
  for (const server of [core, gateway]) server.on("session", session => {
    sessions.add(session); session.on("error", () => {}); session.on("close", () => sessions.delete(session));
  });
  const track = (stream: ServerHttp2Stream | ClientHttp2Stream): void => {
    streams.add(stream); stream.on("error", () => {}); stream.on("close", () => streams.delete(stream));
  };
  core.on("stream", stream => {
    upstream = stream; track(stream); stream.respond({ ":status": 200 }); stream.pause();
  });
  gateway.on("stream", stream => {
    incoming = stream; track(stream); stream.respond({ ":status": 200 });
    const destination = upstreamSession!.request({ ":method": "POST", ":path": "/upload" }, { endStream: false });
    outgoing = destination; track(destination); destination.on("close", outgoingClose.resolve);
    stream.on("end", incomingEnd.resolve);
    stream.on("close", () => {
      stateAtCancel = { ended: stream.readableEnded, finished: stream.writableFinished, errored: Boolean(stream.errored),
        reset: stream.rstCode, pending: destination.writableLength };
      incomingClose.resolve();
    });
    bridge(stream, destination);
  });
  try {
    const corePort = await listen(core), gatewayPort = await listen(gateway);
    upstreamSession = http2.connect(`http://127.0.0.1:${corePort}`); upstreamSession.on("error", () => {});
    await within(new Promise<void>(resolve => upstreamSession!.once("remoteSettings", () => resolve())), "upstream settings");
    client = http2.connect(`http://127.0.0.1:${gatewayPort}`); client.on("error", () => {});
    request = client.request({ ":method": "POST", ":path": "/relay" }, { endStream: false });
    request.on("error", () => {}); request.on("close", clientClose.resolve); request.resume();
    request.end(Buffer.alloc(22_161, "x"));
    await within(incomingEnd.promise, "complete input before cancel");
    assert.ok(outgoing && outgoing.writableLength > 0);
    assert.equal(outgoing.writableFinished, false);
    request.close(http2.constants.NGHTTP2_CANCEL);
    await within(Promise.all([incomingClose.promise, outgoingClose.promise, clientClose.promise]), "backpressured cancel cleanup");
    assert.ok(stateAtCancel?.ended && stateAtCancel.finished && !stateAtCancel.errored);
    assert.equal(stateAtCancel.reset, http2.constants.NGHTTP2_CANCEL);
    assert.ok(stateAtCancel.pending > 0);
    assert.ok(incoming?.closed && outgoing.closed);
    await until(() => upstream?.closed === true);
    // The intentionally paused remote readable retains bytes until its owner
    // consumes or destroys it; that is distinct from a live bridge endpoint.
  } finally {
    request?.destroy(); client?.destroy(); upstreamSession?.destroy();
    for (const stream of streams) stream.destroy();
    for (const session of sessions) session.destroy();
    await Promise.all([new Promise<void>(resolve => core.close(() => resolve())), new Promise<void>(resolve => gateway.close(() => resolve()))]);
  }
});
