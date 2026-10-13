import type { SqliteDatabase } from "./db/client.js";

const countKeys = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;
type CountKey = typeof countKeys[number];
export type TokenCounts = Partial<Record<CountKey, number>> & { inputTokens: number; outputTokens: number; totalTokens: number };

export interface AgentUsageObservation {
  threadId: string;
  turnId: string;
  total: TokenCounts;
  lastRequest?: TokenCounts;
  newThread: boolean;
  providerVersion?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function counts(value: unknown): TokenCounts | undefined {
  const source = object(value);
  if (!source) return undefined;
  const result: Partial<Record<CountKey, number>> = {};
  for (const key of countKeys) {
    if (source[key] === undefined) continue;
    if (!Number.isSafeInteger(source[key]) || (source[key] as number) < 0) return undefined;
    result[key] = source[key] as number;
  }
  if (result.inputTokens === undefined || result.outputTokens === undefined || result.totalTokens === undefined) return undefined;
  return result as TokenCounts;
}

/** Only numeric usage metadata crosses this boundary, never reasoning/prompt content. */
export function parseCodexUsage(value: unknown): Omit<AgentUsageObservation, "newThread" | "providerVersion"> | undefined {
  const event = object(value); const usage = object(event?.tokenUsage);
  const total = counts(usage?.total);
  if (!total || typeof event?.threadId !== "string" || !event.threadId || event.threadId.length > 256 ||
      typeof event.turnId !== "string" || !event.turnId || event.turnId.length > 256) return undefined;
  return { threadId: event.threadId, turnId: event.turnId, total, lastRequest: counts(usage?.last) };
}

interface UsageRow {
  agent_id: string; thread_id: string; turn_id: string;
  total_tokens: number; totals: string; last_request: string | null;
  baseline: string | null; baseline_kind: string; observed_at: string; provider_version: string | null;
}

export function recordAgentUsage(db: SqliteDatabase, agentId: string, event: AgentUsageObservation): void {
  const sanitized = counts(event.total);
  if (!sanitized) throw new Error("Invalid provider token counts.");
  event = { ...event, total: sanitized, lastRequest: counts(event.lastRequest) };
  db.transaction(() => {
    const latest = db.prepare(`select * from agent_usage_snapshots where agent_id = ? and thread_id = ?
      order by total_tokens desc, observed_at desc limit 1`).get(agentId, event.threadId) as UsageRow | undefined;
    if (latest) {
      const previous = JSON.parse(latest.totals) as TokenCounts;
      // A reset or stale cumulative notification is not an increment to add.
      if (event.total.totalTokens < previous.totalTokens || event.total.inputTokens < previous.inputTokens || event.total.outputTokens < previous.outputTokens) return;
    }
    const current = db.prepare(`select * from agent_usage_snapshots where agent_id = ? and thread_id = ? and turn_id = ?`)
      .get(agentId, event.threadId, event.turnId) as UsageRow | undefined;
    const totals = JSON.stringify(event.total);
    if (current?.totals === totals) return;
    let baseline = current?.baseline ?? null;
    let basis = current?.baseline_kind ?? "unknown_resumed_history";
    if (!current && latest) { baseline = latest.totals; basis = "since_previous_observation"; }
    else if (!current && event.newThread) {
      baseline = JSON.stringify(Object.fromEntries(Object.keys(event.total).map((key) => [key, 0])));
      basis = "new_thread";
    }
    db.prepare(`insert into agent_usage_snapshots
      (agent_id, thread_id, turn_id, total_tokens, totals, last_request, baseline, baseline_kind, observed_at, provider_version)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(agent_id, thread_id, turn_id) do update set total_tokens=excluded.total_tokens,
        totals=excluded.totals, last_request=excluded.last_request, observed_at=excluded.observed_at,
        provider_version=excluded.provider_version`)
      .run(agentId, event.threadId, event.turnId, event.total.totalTokens, totals,
        event.lastRequest ? JSON.stringify(event.lastRequest) : null, baseline, basis, new Date().toISOString(), event.providerVersion ?? null);
  }).immediate();
}

export function readAgentUsage(db: SqliteDatabase, agentId: string) {
  const all = db.prepare(`select * from agent_usage_snapshots where agent_id = ? order by observed_at desc, total_tokens desc limit 21`).all(agentId) as UsageRow[];
  const rows = all.slice(0, 20).reverse();
  const threads = new Map<string, { threadId: string; totals: TokenCounts; observedAt: string }>();
  const observations = rows.map((row) => {
    const total = JSON.parse(row.totals) as TokenCounts;
    const baseline = row.baseline ? JSON.parse(row.baseline) as TokenCounts : undefined;
    const growth = baseline ? Object.fromEntries(countKeys.flatMap((key) =>
      total[key] !== undefined && baseline[key] !== undefined && total[key]! >= baseline[key]!
        ? [[key, total[key]! - baseline[key]!]] : [])) : null;
    const latest = threads.get(row.thread_id);
    if (!latest || total.totalTokens >= latest.totals.totalTokens) threads.set(row.thread_id,
      { threadId: row.thread_id, totals: total, observedAt: row.observed_at });
    return { turnId: row.turn_id, threadId: row.thread_id, cumulative: total, growth,
      basis: row.baseline_kind, lastRequest: row.last_request ? JSON.parse(row.last_request) as TokenCounts : null,
      observedAt: row.observed_at, providerVersion: row.provider_version };
  });
  return { status: rows.length ? "observed" : "unknown", provider: rows.length ? "codex" : null, scope: "thread_cumulative",
    hasMore: all.length > 20,
    threads: [...threads.values()], observations,
    note: "Provider-reported snapshots, not an invoice or subscription balance. Do not sum cumulative snapshots. Cached input and reasoning output are breakdowns, not additional totals. Growth is since the stated baseline; unobserved resumed history remains unknown." };
}
