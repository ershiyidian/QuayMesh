import type {Duplex} from "node:stream";
import {setTimeout as delay} from "node:timers/promises";
import {createWindowsLocalPipe} from "./windows-pipe.js";
import type {LocalApiSessions} from "./ipc.js";
import {LOCAL_USER_API_MAX_FRAME_BYTES, localApiError, object, identifier} from "./protocol.js";

const INTERNAL_LIMIT = LOCAL_USER_API_MAX_FRAME_BYTES + 1024;
const BRIDGE_PROTOCOL = "quaymesh.local-user.bridge.v1";
/** A persistent, SID-verified NativeHost pipe carries only request/response
 * frames. No TCP listener, administrator bearer, or generic HTTP proxy exists. */
export function connectNativeUserChannel(options: {endpoint: string; key: string; nodeId: string; configDir: string;
  sessions: LocalApiSessions; ready: (connected: boolean) => void;
  connect?: (endpoint: string) => Duplex}) {
  if (!/^\\\\\.\\pipe\\QuayMesh\.LocalUser\.Core\.[a-f0-9]{32}$/.test(options.endpoint) || !/^[a-f0-9]{64}$/.test(options.key))
    throw localApiError("LOCAL_API_NATIVE_HOST_REQUIRED");
  const stop = new AbortController();
  let socket: Duplex | undefined;
  const active = new Map<string, AbortController>();
  const closeConnection = () => {options.ready(false); for (const value of active.values()) value.abort(); active.clear(); socket?.destroy();};
  const write = (connection: Duplex, value: unknown): Promise<void> => {
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (bytes.length > INTERNAL_LIMIT) throw localApiError("LOCAL_API_RESPONSE_TOO_LARGE");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {connection.destroy(); reject(localApiError("LOCAL_API_TIMEOUT"));}, 10_000);
      connection.write(bytes, error => {clearTimeout(timer); bytes.fill(0); error ? reject(error) : resolve();});
    });
  };
  const loop = (async () => {
    while (!stop.signal.aborted) {
      try {
        const connection = (options.connect ?? createWindowsLocalPipe)(options.endpoint); socket = connection;
        connection.on("error", () => undefined);
        const handshake = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {connection.destroy(); reject(localApiError("LOCAL_API_TIMEOUT"));}, 10_000);
          connection.once("connect", () => {clearTimeout(timer); resolve();});
          connection.once("close", () => {clearTimeout(timer); reject(localApiError("LOCAL_API_UNAVAILABLE"));});
        });
        await handshake; stop.signal.throwIfAborted();
        await write(connection, {protocol: BRIDGE_PROTOCOL, key: options.key, nodeId: options.nodeId, configDir: options.configDir});
        let buffer = Buffer.alloc(0), authenticated = false;
        const handshakeDeadline = setTimeout(() => connection.destroy(), 5_000);
        try {
          for await (const raw of connection) {
            const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            let offset = 0;
            while (offset < bytes.length) {
              const end = bytes.indexOf(10, offset), bound = end < 0 ? bytes.length : end;
              if (buffer.length + bound - offset + (end < 0 ? 0 : 1) > INTERNAL_LIMIT) throw localApiError("LOCAL_API_INVALID_RESPONSE");
              buffer = Buffer.concat([buffer, bytes.subarray(offset, bound)]); offset = end < 0 ? bytes.length : end + 1;
              if (end < 0) continue;
              const value: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(buffer)); buffer.fill(0); buffer = Buffer.alloc(0);
              if (!object(value)) throw localApiError("LOCAL_API_INVALID_RESPONSE");
              if (!authenticated) {
                if (value.protocol !== BRIDGE_PROTOCOL || value.kind !== "ready") throw localApiError("LOCAL_API_UNAUTHORIZED");
                clearTimeout(handshakeDeadline); authenticated = true; options.ready(true); continue;
              }
              if (!identifier(value.connectionId)) throw localApiError("LOCAL_API_INVALID_REQUEST");
              if (value.kind === "cancel") {active.get(value.connectionId)?.abort(); continue;}
              if (value.kind !== "request" || active.has(value.connectionId) || active.size >= 64) throw localApiError("LOCAL_API_INVALID_REQUEST");
              const id = value.connectionId, controller = new AbortController(); active.set(id, controller);
              void options.sessions.run(value.request, response => write(connection, {kind: "response", connectionId: id, response}), controller.signal)
                .catch(() => connection.destroy()).finally(() => {controller.abort(); active.delete(id);});
            }
          }
        } finally {clearTimeout(handshakeDeadline); buffer.fill(0);}
      } catch { /* Discovery stays unavailable; an API outage does not restart or cancel a Task. */ }
      finally {closeConnection();}
      if (!stop.signal.aborted) await delay(1000, undefined, {signal: stop.signal}).catch(() => undefined);
    }
  })();
  return {async close() {stop.abort(); closeConnection(); await loop;}};
}
