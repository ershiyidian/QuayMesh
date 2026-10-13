import { connect, createServer, type Server, type Socket } from "node:net";

export type RuntimeControlOperation = "status" | "stop_admission" | "shutdown";
export interface RuntimeControlRequest {
  protocol: "quaymesh.runtime-control.v1";
  operation: RuntimeControlOperation;
  instanceId: string;
  pid: number;
  startedAt: string;
  deadlineAt?: string;
}
export interface RuntimeControlResponse {
  accepted: boolean;
  state: "received" | "saved" | "stopping" | "rejected";
  error?: string;
}
export interface RuntimeControlServerOptions {
  instanceId: string;
  pid: number;
  startedAt: string;
  handle: (request: RuntimeControlRequest) => Promise<RuntimeControlResponse> | RuntimeControlResponse;
}

function validate(request: RuntimeControlRequest): void {
  if (request.protocol !== "quaymesh.runtime-control.v1" || !/^[A-Za-z0-9._-]{1,160}$/.test(request.instanceId) ||
      !Number.isInteger(request.pid) || request.pid < 1 || !Number.isFinite(Date.parse(request.startedAt)) ||
      !["status", "stop_admission", "shutdown"].includes(request.operation)) {
    throw new Error("Invalid runtime control request.");
  }
}

export function runtimeControlPipeName(instanceId: string): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(instanceId)) throw new Error("Invalid runtime control instance ID.");
  return process.platform === "win32" ? `\\\\.\\pipe\\QuayMesh.Runtime.${instanceId}` : `/tmp/quaymesh-runtime-${instanceId}.sock`;
}

export async function sendRuntimeControl(pipeName: string, request: RuntimeControlRequest, timeoutMs = 3_000): Promise<RuntimeControlResponse> {
  validate(request);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Runtime control timeout is invalid.");
  return await new Promise((resolve, reject) => {
    const socket = connect(pipeName);
    let response = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Runtime control request timed out.")); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.write(JSON.stringify(request) + "\n");
    socket.on("data", (chunk: string) => {
      response += chunk;
      const line = response.indexOf("\n");
      if (line < 0) return;
      clearTimeout(timer); socket.end();
      const parsed = JSON.parse(response.slice(0, line)) as RuntimeControlResponse;
      if (typeof parsed.accepted !== "boolean" || !["received", "saved", "stopping", "rejected"].includes(parsed.state)) reject(new Error("Invalid runtime control response."));
      else resolve(parsed);
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

export function createRuntimeControlServer(options: RuntimeControlServerOptions): { server: Server; close: () => Promise<void> } {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(options.instanceId) || !Number.isInteger(options.pid) || options.pid < 1 || !Number.isFinite(Date.parse(options.startedAt))) throw new Error("Invalid runtime control server identity.");
  const server = createServer((socket: Socket) => {
    let data = "";
    socket.setEncoding("utf8");
    const reject = (error: string) => { socket.end(JSON.stringify({ accepted: false, state: "rejected", error } satisfies RuntimeControlResponse) + "\n"); };
    socket.on("data", async (chunk) => {
      data += chunk;
      if (data.length > 16 * 1024) { reject("request_too_large"); socket.destroy(); return; }
      const line = data.indexOf("\n");
      if (line < 0) return;
      try {
        const request = JSON.parse(data.slice(0, line)) as RuntimeControlRequest;
        validate(request);
        if (request.instanceId !== options.instanceId || request.pid !== options.pid || request.startedAt !== options.startedAt) throw new Error("runtime_identity_mismatch");
        const response = await options.handle(request);
        socket.end(JSON.stringify(response) + "\n");
      } catch (error) { reject(error instanceof Error ? error.message : "invalid_request"); }
    });
  });
  return { server, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
