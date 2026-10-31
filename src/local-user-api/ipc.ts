import {createServer, createConnection, type Socket} from "node:net";
import {mkdir, lstat, open, rename, unlink, chmod} from "node:fs/promises";
import {join, dirname} from "node:path";
import {randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {LOCAL_USER_API_PROTOCOL, LOCAL_USER_API_MAX_FRAME_BYTES, localApiError, localApiFailure,
  parseLocalApiRequest, object, type LocalUserApiRequest, type LocalUserApiResponse, type LocalUserApiMethod} from "./protocol.js";
import type {LocalAuthentication, LocalCredentialVerifier} from "./grants.js";

export type LocalApiForward = (identity: LocalAuthentication, method: LocalUserApiMethod,
  params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

/** Shared by the Unix listener and the private NativeHost pipe. Every
 * watch poll rechecks the credential and central grant; cached auth is absent. */
export class LocalApiSessions {
  private readonly active = new Set<AbortController>();
  constructor(private readonly verifier: LocalCredentialVerifier, private readonly forward: LocalApiForward,
    private readonly options: {pollMs?: number; heartbeatMs?: number; requestMs?: number} = {}) {}
  async run(input: unknown, send: (frame: LocalUserApiResponse) => Promise<void>, signal: AbortSignal): Promise<void> {
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    let request: LocalUserApiRequest | undefined;
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) abort();
    this.active.add(controller);
    try {
      if (this.active.size > 64) throw localApiError("LOCAL_API_BUSY");
      request = parseLocalApiRequest(input);
      const watch = request.method === "events.watch";
      let params = request.params, first = true, lastSent = 0;
      do {
        controller.signal.throwIfAborted();
        const auth = this.verifier.authenticate(request.credential);
        const call = new AbortController(), stop = () => call.abort(controller.signal.reason);
        controller.signal.addEventListener("abort", stop, {once: true});
        const timeout = setTimeout(() => call.abort(localApiError("LOCAL_API_TIMEOUT")), this.options.requestMs ?? 8_000);
        let result: unknown;
        try {
          result = await Promise.race([this.forward(auth, watch ? "events.read" : request.method, params, call.signal),
            new Promise<never>((_, reject) => {call.signal.addEventListener("abort", () => reject(call.signal.reason), {once: true});})]);
        } finally {clearTimeout(timeout); controller.signal.removeEventListener("abort", stop);}
        controller.signal.throwIfAborted();
        const batch = object(result) && Array.isArray(result.items) ? result as Record<string, unknown> & {items: unknown[]} : undefined;
        if (!watch || first || batch && batch.items.length > 0 || Date.now() - lastSent >= (this.options.heartbeatMs ?? 15_000)) {
          await send({protocol: LOCAL_USER_API_PROTOCOL, id: request.id, ok: true,
            result: watch && batch && batch.items.length === 0 ? {...batch, heartbeat: true} : result, done: !watch});
          lastSent = Date.now(); first = false;
        }
        if (!watch) break;
        if (!batch || typeof batch.nextCursor !== "string") throw localApiError("LOCAL_API_INVALID_RESPONSE");
        params = {...params, cursor: batch.nextCursor};
        // Bounded polling even while history has more pages; one watch cannot
        // start an unbounded authority RPC loop or overlap requests.
        await delay(this.options.pollMs ?? 2_000, undefined, {signal: controller.signal});
      } while (!controller.signal.aborted);
    } catch (error) {
      if (!controller.signal.aborted) await send(localApiFailure(request?.id ?? "invalid", error));
    } finally {signal.removeEventListener("abort", abort); controller.abort(); this.active.delete(controller);}
  }
  close() {for (const controller of this.active) controller.abort();}
}

async function privateDirectory(path: string) {
  await mkdir(path, {recursive: true, mode: 0o700});
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw localApiError("LOCAL_API_ENDPOINT_UNSAFE");
}
async function removeStaleSocket(endpoint: string) {
  let stat;
  try {stat = await lstat(endpoint);} catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error;}
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw localApiError("LOCAL_API_ENDPOINT_UNSAFE");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({path: endpoint});
    const timer = setTimeout(() => {socket.destroy(); reject(localApiError("LOCAL_API_ALREADY_RUNNING"));}, 1_000);
    socket.once("connect", () => {clearTimeout(timer); socket.destroy(); reject(localApiError("LOCAL_API_ALREADY_RUNNING"));});
    socket.once("error", error => {clearTimeout(timer); socket.destroy();
      if (["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) resolve(); else reject(error);});
  });
  const current = await lstat(endpoint).catch(() => undefined);
  if (current?.ino === stat.ino) await unlink(endpoint);
}
export async function writeLocalDiscovery(configDir: string, endpoint: string, nodeId: string): Promise<void> {
  const directory = await lstat(configDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0)
    throw localApiError("LOCAL_API_DISCOVERY_UNSAFE");
  const destination = join(configDir, "local-user-api.json"), temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {await handle.writeFile(JSON.stringify({protocol: LOCAL_USER_API_PROTOCOL, endpoint, nodeId}) + "\n");}
  finally {await handle.close();}
  try {await rename(temporary, destination);} finally {await unlink(temporary).catch(() => undefined);}
}

function writeFrame(socket: Socket, value: LocalUserApiResponse): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length > LOCAL_USER_API_MAX_FRAME_BYTES) throw localApiError("LOCAL_API_RESPONSE_TOO_LARGE");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {socket.destroy(); reject(localApiError("LOCAL_API_TIMEOUT"));}, 10_000);
    socket.write(bytes, error => {clearTimeout(timer); error ? reject(error) : resolve();});
  });
}

export async function startLocalUnixApi(options: {configDir: string; nodeId: string; sessions: LocalApiSessions}) {
  if (process.platform === "win32") throw localApiError("LOCAL_API_NATIVE_HOST_REQUIRED");
  const endpoint = join(options.configDir, "local-api", "api.sock");
  await privateDirectory(dirname(endpoint)); await removeStaleSocket(endpoint);
  const clients = new Set<Socket>();
  const server = createServer(socket => {
    if (clients.size >= 64) {socket.destroy(); return;}
    clients.add(socket);
    let pending = Buffer.alloc(0), started = false;
    const controller = new AbortController();
    const timer = setTimeout(() => socket.destroy(), 10_000);
    socket.on("error", () => controller.abort());
    socket.once("close", () => {clearTimeout(timer); controller.abort(); pending.fill(0); clients.delete(socket);});
    socket.on("data", chunk => {
      if (started) {socket.destroy(); return;}
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      if (pending.length + bytes.length > LOCAL_USER_API_MAX_FRAME_BYTES) {socket.destroy(); return;}
      pending = Buffer.concat([pending, bytes]);
      const end = pending.indexOf(10);
      if (end < 0) return;
      started = true; clearTimeout(timer);
      if (end !== pending.length - 1) {socket.destroy(); return;}
      let value: unknown;
      try {value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(pending.subarray(0, end)));}
      catch {void writeFrame(socket, localApiFailure("invalid", localApiError("LOCAL_API_INVALID_REQUEST")))
        .catch(() => socket.destroy()).finally(() => socket.end()); return;}
      pending.fill(0); pending = Buffer.alloc(0);
      void options.sessions.run(value, frame => writeFrame(socket, frame), controller.signal)
        .catch(() => socket.destroy()).finally(() => socket.end());
    });
  });
  await new Promise<void>((resolve, reject) => {server.once("error", reject); server.listen(endpoint, () => {server.off("error", reject); resolve();});});
  let inode: number;
  try {
    await chmod(endpoint, 0o600); inode = (await lstat(endpoint)).ino;
    await writeLocalDiscovery(options.configDir, endpoint, options.nodeId);
  } catch (error) {
    for (const socket of clients) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(endpoint).catch(() => undefined); throw error;
  }
  return {endpoint, async close() {
    options.sessions.close(); for (const socket of clients) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if ((await lstat(endpoint).catch(() => undefined))?.ino === inode) await unlink(endpoint);
  }};
}
