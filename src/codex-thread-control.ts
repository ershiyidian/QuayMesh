import { CodexAppServerRuntime, resolveCodexCommand } from "./local-agent-codex.js";

export interface ThreadSnapshot {
  instanceId: string; identityVerified: boolean; threadId: string; name: string | null;
  cwd: string; status: string; archived: boolean; turnIds: string[]; turnsClosed: boolean;
  openDescendantIds: string[]; inventoryComplete: boolean;
}
export interface ThreadControl {
  inspect(threadId: string): Promise<ThreadSnapshot>;
  archive(threadId: string): Promise<void>;
  unarchive(threadId: string): Promise<void>;
  close(): Promise<void>;
}
const object = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
// Omitted/empty sourceKinds defaults to interactive sources in Codex 0.135.0.
// A descendant safety check must explicitly include subagent and unknown sources.
export const ALL_THREAD_SOURCES = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"] as const;
type MetadataRuntime = Pick<CodexAppServerRuntime, "control" | "identity" | "close">;

/** Uses the existing provider adapter for non-model RPCs, never agent.run/turn.start. */
export class CodexThreadControl implements ThreadControl {
  private runtime?: MetadataRuntime;
  private opening?: Promise<MetadataRuntime>;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly createRuntime?: () => Promise<MetadataRuntime>) {}
  private open(): Promise<MetadataRuntime> {
    this.opening ??= (async () => {
      if (this.createRuntime) { this.runtime = await this.createRuntime(); return this.runtime; }
      const command = resolveCodexCommand(this.env);
      if (!command) throw new Error("Codex metadata service is unavailable.");
      const runtime = new CodexAppServerRuntime({ command: command.executable, env: this.env, version: command.version });
      this.runtime = runtime;
      await runtime.initialize(); return runtime;
    })();
    return this.opening;
  }
  async inspect(threadId: string): Promise<ThreadSnapshot> {
    const deadline = Date.now() + 60_000;
    const runtime = await this.open();
    const identity = await runtime.identity(true);
    const response = object(await runtime.control("thread/read", { threadId, includeTurns: true }));
    const thread = object(response?.thread);
    if (!thread || thread.id !== threadId || !Array.isArray(thread.turns) || typeof thread.cwd !== "string") throw new Error("Incomplete provider thread metadata.");
    // Complete metadata pagination is needed to detect archive's descendant side effects.
    // Do not collect or expose previews, user messages, item contents or hidden reasoning.
    const catalog: { id: string; archived: boolean; parent?: string }[] = [];
    let complete = true;
    catalogScan: for (const archived of [false, true]) {
      let cursor: string | undefined;
      const seen = new Set<string>(); let pages = 0;
      do {
        if (Date.now() > deadline) { complete = false; break catalogScan; }
        const page = object(await runtime.control("thread/list", { archived, cursor, limit: 100,
          sourceKinds: [...ALL_THREAD_SOURCES], modelProviders: [] }));
        if (!page || !Array.isArray(page.data)) throw new Error("Provider inventory is incomplete.");
        for (const value of page.data) {
          const row = object(value); if (typeof row?.id !== "string") { complete = false; continue; }
          const subAgent = object(row.source)?.subAgent;
          const spawned = object(object(subAgent)?.thread_spawn);
          const parent = spawned?.parent_thread_id ?? row.parentThreadId;
          if (subAgent && !spawned && typeof parent !== "string") complete = false;
          catalog.push({ id: row.id, archived, parent: typeof parent === "string" ? parent : undefined });
        }
        const next = page.nextCursor;
        if (next != null && (typeof next !== "string" || seen.has(next))) { complete = false; break; }
        cursor = next || undefined;
        if (cursor) seen.add(cursor);
        if (++pages >= 100 || catalog.length > 10_000) { complete = false; break; }
      } while (cursor);
    }
    const root = catalog.find((row) => row.id === threadId);
    if (new Set(catalog.map((row) => row.id)).size !== catalog.length) complete = false;
    if (!root) throw new Error("Thread was not found in a complete provider inventory.");
    const descendants = new Set<string>(); let change = true;
    while (change) {
      change = false;
      for (const row of catalog) if (row.id !== threadId && (row.parent === threadId || (row.parent && descendants.has(row.parent))) && !descendants.has(row.id)) {
        descendants.add(row.id); change = true;
      }
    }
    const turns = thread.turns.map(object);
    if (turns.some((turn: Record<string, any> | undefined) => typeof turn?.id !== "string")) throw new Error("Incomplete turn identity metadata.");
    return { ...identity, threadId, name: typeof thread.name === "string" ? thread.name : null,
      cwd: thread.cwd, status: String(object(thread.status)?.type ?? "unknown"), archived: root.archived,
      turnIds: turns.map((turn) => turn!.id as string),
      turnsClosed: turns.every((turn) => ["completed", "failed", "interrupted"].includes(String(turn?.status))),
      openDescendantIds: catalog.filter((row) => descendants.has(row.id) && !row.archived).map((row) => row.id), inventoryComplete: complete };
  }
  async archive(threadId: string): Promise<void> { await (await this.open()).control("thread/archive", { threadId }); }
  async unarchive(threadId: string): Promise<void> { await (await this.open()).control("thread/unarchive", { threadId }); }
  async close(): Promise<void> { await this.runtime?.close(); this.runtime = undefined; this.opening = undefined; }
}
