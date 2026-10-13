import type { Request, Response, Router } from "express";
import * as z from "zod/v4";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import type { FederationRuntime, TransferView } from "../federation/runtime.js";
import type { ConsoleOperations } from "../federation/console-dispatch.js";
import type { ConsoleReply, JsonRecord } from "../federation/types.js";
import { parseWorkspaceHandle, workspaceHandle } from "../federation/routing.js";
import { WorkLedger } from "../work-ledger.js";
import { LocalAgentStore } from "../local-agent-store.js";
import type { SessionRuntime } from "../session/runtime.js";
import { mapConcurrent } from "../concurrency.js";
import { WorkbenchFeed } from "./feed.js";
import { aggregateTasks, parseTaskReference } from "./task-aggregation.js";
import { LocalActions } from "./actions.js";
import { readLocalActivity, permitted } from "./local.js";
import { readLocalMetadata, readLocalPage, readLocalOverview, readLocalRunSummaries, readLocalSessionTitles, readLocalTaskIndex, readLocalUsage } from "./local-queries.js";
import { readRunDetail, readFileDiff, readRunPatch, readCommandOutput, textPage } from "./detail.js";
import type { Query } from "./query.js";
import type { Run } from "./types.js";
import { WorkbenchError } from "./types.js";
import { WriteReceipts } from "./receipts.js";

const id = z.string().min(1).max(2048);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const revision = z.number().nonnegative();
const text = (value: unknown): string => typeof value === "string" ? value : "";
const querySchema = z.object({
  node: z.string().optional(), project: z.string().optional(), q: z.string().max(1000).optional(),
  session: z.string().optional(), root: z.string().optional(),
  days: z.coerce.number().int().min(0).max(36500).optional().transform((value) => value === undefined ? undefined : String(value)),
  status: z.string().optional(), sort: z.enum(["newest", "oldest", "tokens", "duration"]).optional(),
  cursor: z.string().max(8192).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().transform((value) => value === undefined ? undefined : String(value)),
  changed: z.string().optional(), execution: z.string().optional(), date: z.string().optional(), finishedDay: z.string().optional(),
  attention: z.string().optional(), tz: z.string().max(100).optional(), kind: z.string().optional(), level: z.string().optional(), hour: z.string().optional(),
});

export const workbenchSession = (csrf: string, settings: boolean, revert: boolean) => ({
  contract: "quaymesh.console.v4", csrf, user: { name: "Owner", role: "owner" },
  capabilities: { read: true, write: true, archive: true, revert, settings, notifications: true, rootReadOnly: false,
    conversations:true,taskLifecycle:true,workspaceLocations:true },
});

export function mountConsoleWorkbench(router: Router, operations: ConsoleOperations, config: ServerConfig, runtime?: FederationRuntime, session?: SessionRuntime) {
  const feed = new WorkbenchFeed(config, runtime);
  const actions = new LocalActions(config, session);
  const receipts = new WriteReceipts(config.stateDir);
  const localId = config.federation?.nodeId ?? "local";
  const safe = (fn: (req: Request) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
    try { res.json(await fn(req)); }
    catch (error) {
      const status = error instanceof WorkbenchError ? error.status : error instanceof z.ZodError ? 422 : 500;
      res.status(status).json({ code: error instanceof WorkbenchError ? error.code : error instanceof z.ZodError ? "invalid_input" : "console_read_failed",
        message: error instanceof Error ? error.message : String(error) });
    }
  };
  const localGet = (path: string, fn: (req: Request) => unknown | Promise<unknown>) => operations.get(`/api/workbench${path}`, safe(fn));
  const recorded = (scope: string, fn: (req: Request) => unknown | Promise<unknown>) => (req: Request) => {
    const requestKey = key.parse(req.body?.requestKey);
    const target = req.body?.id ?? req.body?.projectId ?? req.body?.previewId ?? "";
    return receipts.execute(`${scope}:${req.path}:${target}`, requestKey, req.path, req.body, () => fn(req));
  };
  const localPost = (path: string, fn: (req: Request) => unknown | Promise<unknown>) => operations.post(`/api/workbench${path}`, safe(recorded("node", fn)));
  const get = (path: string, fn: (req: Request) => unknown | Promise<unknown>) => router.get(`/api/v4${path}`, safe(fn));
  const post = (path: string, fn: (req: Request) => unknown | Promise<unknown>) => router.post(`/api/v4${path}`, safe(recorded("console", async (req) => {
    const result = await fn(req); feed.invalidate(); return result;
  })));
  const decode = (reference: string) => {
    const result = parseWorkspaceHandle(reference);
    if (!result) throw new WorkbenchError("任务或项目引用缺少所属节点", 400, "invalid_reference");
    return result;
  };
  const call = async <T>(node: string, path: string, body?: unknown): Promise<T> => {
    if (node !== localId) return feed.call<T>(node, path, body);
    const reply = await operations.dispatch(body === undefined ? "GET" : "POST", path, body);
    if (reply.status >= 400) {
      const error = reply.body as { message?: string; code?: string };
      throw new WorkbenchError(error.message || "操作失败", reply.status, error.code || "operation_failed");
    }
    return reply.body as T;
  };
  const routeRun = (req: Request) => decode(text(req.params.id));
  const rawRunDetail = async (reference: string) => {
    const target = decode(reference);
    return call<Awaited<ReturnType<typeof readRunDetail>>>(target.node, `/workbench/runs/${encodeURIComponent(target.local)}`);
  };
  const taskPhases = async (reference: string): Promise<{ task: Run; phases: Run[]; complete: boolean }> => {
    const taskRef = parseTaskReference(reference);
    if (taskRef) {
      const result = await feed.taskRuns(taskRef);
      if (!result.runs.length) throw new WorkbenchError("任务不存在",404,"task_not_found");
      return {task:aggregateTasks(result.runs)[0]!,phases:result.runs,complete:result.complete};
    }
    const primary = await rawRunDetail(reference);
    if (primary.run.taskId) {
      const result = await feed.taskRuns(primary.run.taskId);
      if (!result.runs.length) return { task: primary.run, phases: [primary.run], complete: false };
      return { task: aggregateTasks(result.runs)[0]!, phases: result.runs, complete: result.complete };
    }
    if (!primary.run.sessionId) return { task: primary.run, phases: [primary.run], complete: true };
    const result = await feed.sessionRuns(primary.run.sessionId);
    if (!result.runs.length) return { task: primary.run, phases: [primary.run], complete: false };
    return { task: aggregateTasks(result.runs)[0]!, phases: result.runs, complete: result.complete };
  };
  const aggregateRunDetail = async (reference: string) => {
    if (parseTaskReference(reference)) {
      const { task, phases } = await taskPhases(reference);
      const details = await mapConcurrent(task.phaseRefs ?? phases.map((phase) => phase.id), 4,
        async (phase) => ({ phase, detail: await rawRunDetail(phase) }));
      return mergeTaskDetails(task, details);
    }
    return rawRunDetail(reference);
  };
  const search = (req: Request): Query => querySchema.parse(req.query);
  const queryString = (req: Request) => new URLSearchParams(Object.entries(search(req)).filter((pair): pair is [string, string] => pair[1] !== undefined)).toString();

  localGet("/metadata", async () => {
    const metadata=readLocalMetadata(config);
    if(!runtime || !metadata.settings)return metadata;
    const saved=await runtime.request<JsonRecord>(localId,"settings.get",{});
    if(typeof saved.revision!=="number"||!Number.isInteger(saved.revision))throw new WorkbenchError("节点持久设置没有有效修订号",503,"settings_revision_unavailable");
    const revision=saved.revision as number;
    metadata.settings.revision=revision;
    metadata.roots.forEach(root=>{root.revision=revision;});
    return metadata;
  });
  localGet("/runs", (req) => readLocalPage(config, search(req)));
  localGet("/task-index", () => readLocalTaskIndex(config));
  localGet("/session-titles", () => readLocalSessionTitles(config));
  localGet("/run-summaries", (req) => {
    const raw = text(req.query.ids);
    const ids = raw ? raw.split(",").map((value) => decodeURIComponent(value)).filter(Boolean) : [];
    return readLocalRunSummaries(config, ids);
  });
  localGet("/overview", (req) => readLocalOverview(config, text(req.query.tz) || "UTC"));
  localGet("/usage", (req) => readLocalUsage(config, search(req)));
  localGet("/runs/:id", (req) => readRunDetail(config, text(req.params.id), session));
  localGet("/runs/:id/files/:file", (req) => readFileDiff(config, text(req.params.id), text(req.params.file), text(req.query.cursor) || undefined, session));
  localGet("/runs/:id/patch", (req) => readRunPatch(config, text(req.params.id), text(req.query.cursor) || undefined, session));
  localGet("/runs/:id/commands/:command", (req) => readCommandOutput(config, text(req.params.id), text(req.params.command), text(req.query.cursor) || undefined, session));
  localGet("/projects/:id/sessions", (req) => actions.sessions(text(req.params.id)));
  localGet("/activity", (req) => {
    const kind = text(req.query.kind);
    if (kind === "audit") { const entries = actions.audit.entries(); return { items: entries, total: entries.length }; }
    const query = { limit: Math.min(1_000_100, Number(req.query.limit) || 100), q: text(req.query.q), level: text(req.query.level), hour: text(req.query.hour) };
    const saved = readLocalActivity(config, kind, query);
    if (kind !== "events" || !runtime) return saved;
    const recent = (runtime.status().events as Array<{ time: string; kind: string; message: string; nodeId?: string }>).map((event) => ({
      id: `network:${localId}:${event.time}:${event.kind}:${event.message}`, time: Date.parse(event.time),
      nodeId: localId, level: event.kind.includes("error") ? "error" : event.kind.includes("warn") ? "warn" : "info",
      message: event.message, details: { source: "federation", kind: event.kind, peer: event.nodeId ?? null },
    })).filter((event) => (!query.q || event.message.toLocaleLowerCase().includes(query.q.toLocaleLowerCase()))
      && (!query.level || event.level === query.level));
    const selected = recent.filter((event) => !query.hour || Math.floor(event.time / 3600000) === Number(query.hour));
    const bins = [...saved.bins, ...recent.map((event) => ({ start: Math.floor(event.time / 3600000) * 3600000,
      count: 1, errors: Number(event.level === "error"), warnings: Number(event.level === "warn") }))];
    return { items: [...saved.items, ...selected].sort((a, b) => b.time - a.time).slice(0, query.limit), total: saved.total + selected.length, bins };
  });

  localPost("/runs/review", (req) => {
    const input = z.object({ id, expectedRevision: revision, completeExecution: z.boolean().optional(), verdict: z.enum(["accept", "reject"]), note: z.string().max(4000), requestKey: key }).parse(req.body);
    if (input.verdict === "reject" && !input.note.trim()) throw new WorkbenchError("请填写驳回原因", 422, "note_required");
    return actions.review(input, input.verdict, input.note, input.requestKey);
  });
  localPost("/runs/:id/control", (req) => actions.runControl(text(req.params.id), z.object({ action: z.enum(["interrupt", "resume"]), expectedRevision: revision, requestKey: key }).parse(req.body)));
  localPost("/revert/preview", (req) => {
    const input = z.object({ id, files: z.array(id).min(1).max(1000), expectedRevision: revision }).parse(req.body);
    return actions.revertPreview(input.id, input.files, input.expectedRevision);
  });
  localPost("/revert/commit", (req) => {
    const input = z.object({ previewId: id, confirmationHash: id, requestKey: key }).parse(req.body);
    return actions.revertCommit(input.previewId, input.confirmationHash, input.requestKey);
  });
  localPost("/archive", (req) => {
    const input = z.object({ projectId: id, mode: z.enum(["archive", "restore"]).optional(), ids: z.array(id).max(100).optional(), batchId: id.optional(), confirmationHash: id.optional(), externalIdleConfirmed: z.boolean().optional() }).parse(req.body);
    return actions.archive(input.projectId, input);
  });
  localPost("/sessions/:id/protect", (req) => {
    const input = z.object({ protected: z.boolean(), expectedRevision: revision, requestKey: key }).parse(req.body);
    const ledger = new WorkLedger(config.stateDir);
    try {
      const thread = ledger.thread(text(req.params.id));
      if (!permitted(config, ledger.getProject(thread.project_id).root)) throw new WorkbenchError("此会话不在允许访问的项目内", 403);
      if (thread.revision !== input.expectedRevision) throw new WorkbenchError("会话已经更新", 409, "revision_conflict");
      ledger.protectThread(thread.project_id, thread.id, input.protected);
      actions.audit.record("session.protect", thread.id, Boolean(thread.protected), input.protected, input.requestKey);
      return { saved: true };
    } finally { ledger.close(); }
  });
  localPost("/sessions/:id/control", async (req) => {
    const input = z.object({ action: z.enum(["steer", "takeover", "return"]), expectedRevision: revision, expectedTurnId: z.string().nullable().optional(), prompt: z.string().max(12000).optional(), requestKey: key }).parse(req.body);
    const ledger = new WorkLedger(config.stateDir);
    const store = new LocalAgentStore(config.stateDir);
    try {
      const thread = ledger.thread(text(req.params.id));
      const agent = store.getById(thread.agent_id);
      if (!agent || agent.controlRevision !== input.expectedRevision) throw new WorkbenchError("会话控制状态已变化", 409, "revision_conflict");
      const run = ledger.threadRuns(thread.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (!run) throw new WorkbenchError("会话没有可控制的执行记录");
      const receipt = await call<JsonRecord>(localId, `/projects/${encodeURIComponent(thread.project_id)}/threads/${encodeURIComponent(thread.id)}/control`, {
        action: input.action === "return" ? "returnControl" : input.action, workRunId: run.id, requestKey: input.requestKey,
        ...(input.expectedTurnId ? { expectedTurnId: input.expectedTurnId } : {}), ...(input.prompt ? { prompt: input.prompt } : {}),
      });
      actions.audit.record(`session.${input.action}`, thread.id, null, { controlState: receipt.controlState }, input.requestKey);
      return { status: "accepted", receipt };
    } finally { store.close(); ledger.close(); }
  });
  localPost("/settings", async (req) => {
    if (!runtime) throw new WorkbenchError("此节点未启用集群设置");
    const input = z.object({ expectedRevision: revision, settings: z.record(z.string(), z.unknown()), requestKey: key }).parse(req.body);
    const before = await runtime.request<JsonRecord>(localId, "settings.get", {});
    if(before.revision!==input.expectedRevision)throw new WorkbenchError("节点持久设置已经更新，请刷新后重试",409,"revision_conflict");
    const result = await runtime.request<JsonRecord>(localId, "settings.update", {...input.settings,expectedRevision:input.expectedRevision});
    actions.audit.record("node.settings.update", localId, { nickname: before.nickname, priority: before.priority }, { nickname: result.nickname, priority: result.priority }, input.requestKey);
    return { saved:true,revision:result.savedRevision??result.revision,appliedRevision:result.appliedRevision??null,pending:result.pending===true };
  });

  get("/fleet/status", () => feed.fleet());
  get("/overview", (req) => feed.overview(text(req.query.tz) || "UTC"));
  get("/projects", async () => { const value = await feed.metadata(); return { items: value.projects, sources: value.sources, complete: value.complete }; });
  get("/roots", async () => { const value = await feed.metadata(); return { items: value.roots, sources: value.sources, complete: value.complete }; });
  get("/runs", (req) => feed.runs(search(req)));
  get("/usage", (req) => feed.usage(search(req)));
  get("/runs/:id", (req) => aggregateRunDetail(text(req.params.id)));
  get("/runs/:id/files/:file", async (req) => {
    const routed = decodeTaskPart(text(req.params.file));
    const target = routed ? decode(routed.run) : routeRun(req);
    const file = routed?.id ?? text(req.params.file);
    const cursor = z.string().max(8192).optional().parse(req.query.cursor);
    const parameters = new URLSearchParams(cursor === undefined ? {} : { cursor });
    return call(target.node, `/workbench/runs/${encodeURIComponent(target.local)}/files/${encodeURIComponent(file)}?${parameters}`);
  });
  get("/runs/:id/commands/:command", async (req) => {
    const routed = decodeTaskPart(text(req.params.command));
    const target = routed ? decode(routed.run) : routeRun(req);
    const command = routed?.id ?? text(req.params.command);
    const cursor = z.string().max(8192).optional().parse(req.query.cursor);
    const parameters = new URLSearchParams(cursor === undefined ? {} : { cursor });
    return call(target.node, `/workbench/runs/${encodeURIComponent(target.local)}/commands/${encodeURIComponent(command)}?${parameters}`);
  });
  get("/runs/:id/patch", async (req) => {
    const reference = text(req.params.id);
    const taskRef = parseTaskReference(reference);
    if (!taskRef) {
      const target = routeRun(req);
      const cursor = z.string().max(8192).optional().parse(req.query.cursor);
      const parameters = new URLSearchParams(cursor === undefined ? {} : { cursor });
      return call(target.node, `/workbench/runs/${encodeURIComponent(target.local)}/patch?${parameters}`);
    }
    const { phases, complete } = await taskPhases(reference);
    if (!complete) throw new WorkbenchError("部分工作区状态尚未取得，请刷新后再导出补丁", 409, "task_incomplete");
    const current = phases.filter((phase) => phase.currentPhase !== false);
    if (current.length !== 1) throw new WorkbenchError("此任务包含多个当前工作区，请进入具体工作区后导出补丁", 409, "cross_workspace_patch_not_supported");
    const target = decode(current[0]!.id);
    const cursor = z.string().max(8192).optional().parse(req.query.cursor);
    const parameters = new URLSearchParams(cursor === undefined ? {} : { cursor });
    return call(target.node, `/workbench/runs/${encodeURIComponent(target.local)}/patch?${parameters}`);
  });
  get("/projects/:id/sessions", async (req) => {
    const target = routeRun(req);
    const data=await call<ReturnType<LocalActions['sessions']>>(target.node, `/workbench/projects/${encodeURIComponent(target.local)}/sessions`);
    return feed.projectConversations(data);
  });
  get("/activity", async (req) => {
    const query = search(req);
    const sources = feed.sources().filter(source => !query.node || source.nodeId === query.node);
    const observed = new Map<string, number>();
    const index = { sources, complete: sources.every((source) => !source.stale) };
    z.coerce.number().int().min(0).max(1_000_000).parse(query.cursor ?? 0);
    const offset = Number(query.cursor ?? 0), limit = 25, kind = query.kind ?? "events";
    let items: Array<Record<string, any>> = [];
    let databaseTotal: number | null = null;
    const databaseBins: Array<{ start: number; count: number; errors: number; warnings: number }> = [];
    const errors: Array<{ nodeId: string; message: string }> = [];
    if (kind === "transfers") {
      const transfers = runtime ? (await mapConcurrent(index.sources.filter((source) => source.online), 4, async (source) => {
        try {
          const result = await runtime.request<TransferView[]>(source.nodeId, "transfers.list", {}, 8000);
          observed.set(source.nodeId,Date.now()); return result;
        }
        catch (error) { errors.push({ nodeId: source.nodeId, message: error instanceof Error ? error.message : String(error) }); return []; }
      })).flat() : [];
      items = transfers.map((transfer) => ({ id: transfer.id, nodeId: transfer.nodeId, source: transfer.source, destination: transfer.destination,
        bytes: transfer.bytes, total: transfer.totalBytes, status: transfer.status,
        speed: null, startedAt: Date.parse(transfer.startedAt), revision: transfer.finishedAt ?? transfer.startedAt, error: transfer.error ?? null }));
    } else {
      const results = await mapConcurrent(index.sources.filter((source) => source.online && (!query.node || source.nodeId === query.node)), 4, async (source) => {
        try {
          const result = await call<{ items: Array<Record<string, any>>; total: number; bins?: typeof databaseBins }>(source.nodeId,
            `/workbench/activity?${new URLSearchParams({ kind, limit: String(offset + limit), q: query.q ?? "", level: query.level ?? "", hour: query.hour ?? "" })}`);
          observed.set(source.nodeId,Date.now()); return result;
        }
        catch (error) { errors.push({ nodeId: source.nodeId, message: error instanceof Error ? error.message : String(error) }); return { items: [], total: 0 }; }
      });
      items = results.flatMap((result) => result.items);
      if (kind !== "audit") { databaseTotal = results.reduce((sum, result) => sum + result.total, 0); databaseBins.push(...results.flatMap((result) => result.bins ?? [])); }
    }
    const selected = items.filter((item) => (!query.node || item.nodeId === query.node)
      && (!query.q || JSON.stringify(item).toLocaleLowerCase().includes(query.q.toLocaleLowerCase()))
      && (!query.level || item.level === query.level));
    const bins = Array.from({ length: 24 }, (_, index) => {
      const start = Math.floor(Date.now() / 3600000) * 3600000 - (23 - index) * 3600000;
      const values = databaseBins.filter((bin) => bin.start === start);
      return { start, count: values.reduce((sum, bin) => sum + bin.count, 0), errors: values.reduce((sum, bin) => sum + bin.errors, 0), warnings: values.reduce((sum, bin) => sum + bin.warnings, 0) };
    });
    const filtered = selected.filter((item) => !query.hour || Math.floor(item.time / 3600000) === Number(query.hour)).sort((a, b) => (b.time ?? b.startedAt ?? 0) - (a.time ?? a.startedAt ?? 0));
    const total = databaseTotal ?? filtered.length;
    return { items: filtered.slice(offset, offset + limit), total, offset, limit, nextCursor: offset + limit < total ? String(offset + limit) : null, bins,
      sources: index.sources.map(source => {
        const error=errors.find(item=>item.nodeId===source.nodeId);
        return error ? {...source,state:"error",stale:true,error:error.message}
          : observed.has(source.nodeId) ? {...source,state:"ready",stale:false,observedAt:observed.get(source.nodeId),error:null}
          : source;
      }),
      complete: errors.length === 0 && sources.every(source=>source.online) };
  });

  post("/runs/review", async (req) => {
    const input = z.object({ refs: z.array(z.object({ id, expectedRevision: revision, completeExecution: z.boolean().optional() })).min(1).max(100), verdict: z.enum(["accept", "reject"]), note: z.string().max(4000), requestKey: key }).parse(req.body);
    const results = await mapConcurrent(input.refs, 4, async (ref) => {
      try {
        const { task, phases, complete } = await taskPhases(ref.id);
        if (!complete) throw new WorkbenchError("部分工作区状态尚未取得，请刷新后再验收", 409, "task_incomplete");
        if (task.revision !== ref.expectedRevision) throw new WorkbenchError("任务已更新，请刷新后再次确认", 409, "revision_conflict");
        const actionable = phases.filter((phase) => phase.currentPhase !== false && (phase.actions.review || phase.actions.complete));
        if (!actionable.length) throw new WorkbenchError("所选任务没有可验收的结果", 409, "review_unavailable");
        const childResults = await mapConcurrent(actionable, 4, async (phase) => {
          const target = decode(phase.id);
          return call<Record<string, unknown>>(target.node, "/workbench/runs/review", {
            id: target.local,
            expectedRevision: phase.revision,
            completeExecution: phase.actions.complete === true,
            verdict: input.verdict,
            note: input.note,
            requestKey: input.requestKey,
          });
        });
        return { id: ref.id, ok: true, phases: childResults.length, receipts: childResults };
      }
      catch (error) { return { id: ref.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
    });
    return { results };
  });
  post("/runs/:id/control", async (req) => {
    const input = z.object({ action: z.enum(["interrupt", "resume"]), expectedRevision: revision, requestKey: key }).parse(req.body);
    const reference = text(req.params.id);
    const { task, phases, complete } = await taskPhases(reference);
    if (!complete) throw new WorkbenchError("部分工作区状态尚未取得，请刷新后继续", 409, "task_incomplete");
    if (task.revision !== input.expectedRevision) throw new WorkbenchError("任务已更新，请刷新后继续", 409, "revision_conflict");
    const actionable = phases.filter((phase) => phase.currentPhase !== false
      && (input.action === "interrupt" ? phase.actions.interrupt : phase.actions.resume));
    if (!actionable.length) throw new WorkbenchError(input.action === "interrupt" ? "当前任务没有可中断的执行" : "当前任务没有可恢复的执行");
    const results = await mapConcurrent(actionable, 4, async (phase) => {
      const target = decode(phase.id);
      return call<Record<string, unknown>>(target.node, `/workbench/runs/${encodeURIComponent(target.local)}/control`, {
        ...input,
        expectedRevision: phase.revision,
      });
    });
    return { status: results.every((result) => result.status === "completed") ? "completed" : "accepted", results };
  });
  post("/runs/revert/preview", async (req) => {
    const reference = text(req.body.id);
    const taskRef = parseTaskReference(reference);
    let target;
    let files: string[] = Array.isArray(req.body.files) ? req.body.files.map(String) : [];
    let expectedRevision = Number(req.body.expectedRevision);
    if (taskRef) {
      const { task, phases, complete } = await taskPhases(reference);
      if (!complete) throw new WorkbenchError("部分工作区状态尚未取得，请刷新后再还原文件", 409, "task_incomplete");
      if (task.revision !== expectedRevision) throw new WorkbenchError("任务已更新，请刷新后再次确认", 409, "revision_conflict");
      const current = phases.filter((phase) => phase.currentPhase !== false);
      if (current.length !== 1) throw new WorkbenchError("跨工作区任务请进入具体工作区后再还原文件", 409, "cross_workspace_revert_not_supported");
      target = decode(current[0]!.id);
      expectedRevision = current[0]!.revision;
      files = files.map((file) => {
        const routed = decodeTaskPart(file);
        if (!routed || routed.run !== current[0]!.id) throw new WorkbenchError("所选文件不属于当前工作区阶段", 400, "invalid_file_reference");
        return routed.id;
      });
    } else {
      target = decode(reference);
    }
    const result = await call<Record<string, unknown>>(target.node, "/workbench/revert/preview", { ...req.body, id: target.local, files, expectedRevision });
    return { ...result, id: workspaceHandle(target.node, String(result.id)) };
  });
  post("/runs/revert/commit", (req) => { const target = decode(text(req.body.previewId)); return call(target.node, "/workbench/revert/commit", { ...req.body, previewId: target.local }); });
  for (const action of ["protect", "control"]) post(`/sessions/:id/${action}`, (req) => {
    const target = routeRun(req); return call(target.node, `/workbench/sessions/${encodeURIComponent(target.local)}/${action}`, req.body);
  });
  post("/archive/preview", async (req) => {
    const target = decode(text(req.body.projectId));
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((value: string) => { const ref = decode(value); if (ref.node !== target.node) throw new WorkbenchError("归档会话必须属于同一个项目节点"); return ref.local; }) : undefined;
    const result = await call<Record<string, unknown>>(target.node, "/workbench/archive", { ...req.body, projectId: target.local, ids: ids?.length ? ids : undefined });
    return { ...result, id: workspaceHandle(target.node, JSON.stringify([target.local, result.id])) };
  });
  post("/archive/commit", async (req) => {
    const target = decode(text(req.body.previewId));
    const [projectId, batchId] = z.tuple([id, id]).parse(JSON.parse(target.local));
    const batch = await call(target.node, "/workbench/archive", { ...req.body, projectId, batchId });
    return { batch };
  });
  post("/nodes/:id/settings", async (req) => {
    if (!runtime) throw new WorkbenchError("集群设置未启用");
    const input = z.object({ expectedRevision: revision, requestKey: key, settings: z.object({ name: z.string().min(1), priority: z.number().int().min(0).max(1000), egress: z.object({ enabled: z.boolean(), inherit: z.boolean(), config: z.string(), port: z.number().int().min(1).max(65535), probe: z.url(), recovery: z.number().min(0).max(300) }) }) }).parse(req.body);
    const node = text(req.params.id);
    const current = await runtime.request<any>(node, "settings.get", {});
    const proxy = new URL(current.egress.proxyUrl); proxy.port = String(input.settings.egress.port);
    return call(node, "/workbench/settings", { expectedRevision: input.expectedRevision, requestKey: input.requestKey,
      settings: { nickname: input.settings.name, priority: input.settings.priority, egress: { ...current.egress,
        enabled: input.settings.egress.enabled, inheritProxy: input.settings.egress.inherit,
        mihomoConfig: input.settings.egress.config || null, proxyUrl: proxy.href, probeUrl: input.settings.egress.probe, recoveryDelayMs: input.settings.egress.recovery * 1000 } } });
  });
  post("/roots/save", async (req) => {
    if (!runtime) throw new WorkbenchError("根目录管理需要启用集群配置");
    const input = z.object({ requestKey: key, expectedRevision: revision, root: z.object({ id, nodeId: id, name: z.string().min(1).max(100), path: z.string().min(1), description: z.string().max(1000), tags: z.array(z.string()), enabled: z.boolean(), readOnly: z.boolean() }) }).parse(req.body);
    if (input.root.readOnly) throw new WorkbenchError("当前执行节点不支持根目录级只读设置", 422, "root_readonly_unsupported");
    const localRoot = parseWorkspaceHandle(input.root.id)?.local ?? input.root.id;
    const current = await runtime.request<any>(input.root.nodeId, "settings.get", {});
    const root = { id: localRoot, nickname: input.root.name, path: input.root.path, description: input.root.description, tags: input.root.tags, enabled: input.root.enabled };
    const roots = [...current.roots.filter((value: { id: string }) => value.id !== localRoot), root];
    const index = await call<ReturnType<typeof readLocalMetadata>>(input.root.nodeId, "/workbench/metadata");
    if (input.expectedRevision === 0 && index.roots.some((value) => value.localId === localRoot)) throw new WorkbenchError("这个根目录标识已经存在", 409, "revision_conflict");
    return call(input.root.nodeId, "/workbench/settings", { expectedRevision: input.expectedRevision || current.revision, requestKey: input.requestKey, settings: { roots } });
  });
  post("/egress/sync", async (req) => {
    const input = z.object({ sourceNodeId: z.string().optional(), text: z.string().max(256 * 1024).optional(), nodeIds: z.array(id).min(1).max(20), reload: z.boolean(), requestKey: key }).parse(req.body);
    if (!runtime) throw new WorkbenchError("统一出口设置未启用");
    const source = input.text ?? await runtime.request<string>(input.sourceNodeId!, "mihomo.read", {});
    const results = await mapConcurrent(input.nodeIds, 3, async (nodeId) => {
      try { const result = await runtime.request<any>(nodeId, "mihomo.import", { text: source, reload: input.reload });
        return { nodeId, ...result, ok: result.saved === true, reloaded: result.reloaded === true }; }
      catch (error) { return { nodeId, ok: false, error: error instanceof Error ? error.message : String(error) }; }
    });
    actions.audit.record("egress.sync", input.nodeIds.join(","), null, { results }, input.requestKey);
    return { results };
  });
  post("/transfers/cancel", async (req) => {
    if (!runtime) throw new WorkbenchError("文件传输未启用");
    const result = await runtime.copyArtifact({ action: "cancel", copy_id: text(req.body.id) });
    return { transfer: result, status: "accepted" };
  });
  return { feed };
}

type RunDetail = Awaited<ReturnType<typeof readRunDetail>>;
type RoutedTaskDetail = { phase: string; detail: RunDetail };

const TASK_PART_PREFIX = "tqpart:";

function encodeTaskPart(run: string, id: string): string {
  return TASK_PART_PREFIX + Buffer.from(JSON.stringify([run, id]), "utf8").toString("base64url");
}

function decodeTaskPart(value: string): { run: string; id: string } | null {
  if (!value.startsWith(TASK_PART_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(TASK_PART_PREFIX.length), "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
      throw new Error("shape");
    }
    return { run: parsed[0], id: parsed[1] };
  } catch {
    throw new WorkbenchError("任务详情引用无效，请重新打开任务", 400, "invalid_task_detail_reference");
  }
}

function mergeTaskDetails(task: Run, phases: RoutedTaskDetail[]): RunDetail {
  const currentRefs = new Set(task.currentPhaseRefs ?? task.phaseRefs ?? phases.map((item) => item.phase));
  const current = phases.filter((item) => currentRefs.has(item.phase));
  const singleCurrentPhase = current.length === 1;
  const files = current.flatMap(({ phase, detail }) => detail.files.map((file) => ({
    ...file,
    id: encodeTaskPart(phase, file.id),
    revertible: singleCurrentPhase && file.revertible,
  })));
  const commands = phases.flatMap(({ phase, detail }) => detail.commands.map((command) => ({
    ...command,
    id: encodeTaskPart(phase, command.id),
  }))).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const agents = uniqueBy(phases.flatMap(({ detail }) => detail.agents), (agent) => `${agent.provider}:${agent.id}`);
  const evidence = phases.flatMap(({ detail }) => detail.evidence);
  const timeline = phases.flatMap(({ detail }) => detail.timeline).sort((a, b) => a.time - b.time);
  const instructions = uniqueBy(phases.flatMap(({ detail }) => detail.instructions), (item) => item.path);
  const skills = uniqueBy(phases.flatMap(({ detail }) => detail.skills), (item) => `${item.name}:${item.path}`);
  const warnings = [...new Set([...task.warnings, ...phases.flatMap(({ detail }) => detail.warnings)])];
  const summary = task.executionStatus === "running" ? "任务正在执行"
    : task.executionStatus === "waiting" || task.executionStatus === "idle" ? "当前没有受管操作，等待下一步指令"
      : "查看下方按工作区保存的执行记录";
  return {
    run: {
      ...task,
      actions: {
        interrupt: task.actions.interrupt,
        resume: task.actions.resume,
        review: task.actions.review,
        complete: task.actions.complete,
        revert: singleCurrentPhase && task.actions.revert,
        patch: singleCurrentPhase && task.actions.patch !== false,
      },
    },
    summary,
    evidence,
    files,
    commands,
    agents,
    timeline,
    instructions,
    skills,
    warnings,
    revision: task.revision,
  };
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const result = new Map<string, T>();
  for (const value of values) result.set(key(value), value);
  return [...result.values()];
}
