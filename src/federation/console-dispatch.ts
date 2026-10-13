import type { Request, Response, Router } from "express";
import type { ConsoleReply } from "./types.js";
type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
/** One set of handlers serves HTTP and authenticated node RPC. */
export class ConsoleOperations {
  private readonly entries: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  constructor(private readonly router: Router) {}
  get(path: string, handler: Handler): void { this.register("GET", path, handler); }
  post(path: string, handler: Handler): void { this.register("POST", path, handler); }
  private register(method: "GET" | "POST", path: string, handler: Handler): void {
    this.router[method === "GET" ? "get" : "post"](path, handler);
    const keys: string[] = [];
    const pattern = path.split("/").map((part) => {
      if (part.startsWith(":")) { keys.push(part.slice(1)); return "([^/]+)"; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("/");
    this.entries.push({ method, pattern: new RegExp(`^${pattern}/?$`), keys, handler });
  }
  async dispatch(method: string, path: string, body?: unknown): Promise<ConsoleReply> {
    const url = new URL(path, "http://console.local");
    const pathname = url.pathname.startsWith("/api/") ? url.pathname : `/api${url.pathname}`;
    for (const entry of this.entries) {
      const match = method === entry.method && entry.pattern.exec(pathname); if (!match) continue;
      const request = { method, body, params: Object.fromEntries(entry.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])),
        query: Object.fromEntries(url.searchParams), path: pathname, url: pathname + url.search } as unknown as Request;
      const reply: ConsoleReply = { status: 200, body: null };
      const response = { status: (status: number) => { reply.status = status; return response; },
        json: (value: unknown) => { reply.body = value; return response; },
        sendStatus: (status: number) => { reply.status = status; return response; } } as unknown as Response;
      try { await entry.handler(request, response); }
      catch (error) { return { status: 400, body: { message: error instanceof Error ? error.message : String(error) } }; }
      return reply;
    }
    return { status: 404, body: { message: "找不到管理操作" } };
  }
}
