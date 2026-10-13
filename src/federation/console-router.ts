import express, { type Router } from "express";
import type { FederationRuntime } from "./runtime.js";
import type { JsonRecord, ConsoleReply } from "./types.js";
import { mapConcurrent } from "../concurrency.js";

/** Mounted AFTER the existing owner session and CSRF middleware. */
export function mountFleetApi(router: Router, runtime?: FederationRuntime): void {
  router.get("/api/fleet/status", (_req, res) => res.json(runtime?.status() ?? { enabled: false }));
  if (!runtime) return;
  const operation = (fn: (body: JsonRecord) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
    try { res.json(await fn(req.body ?? {})); }
    catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : String(error) }); }
  };
  router.post("/api/fleet/settings/get", operation((body) => runtime.request(String(body.nodeId), "settings.get", {})));
  router.post("/api/fleet/settings/update", operation((body) => runtime.request(String(body.nodeId), "settings.update", body.settings)));
  router.post("/api/fleet/mihomo/sync", operation(async (body) => {
    const text = typeof body.text === "string" ? body.text : await runtime.request<string>(String(body.sourceNodeId), "mihomo.read", {});
    if (!Array.isArray(body.nodeIds) || !body.nodeIds.length) throw new Error("请选择目标节点");
    return { results: await mapConcurrent(body.nodeIds, 3, async (nodeId) => {
      try { return { nodeId, ...await runtime.request<JsonRecord>(String(nodeId), "mihomo.import", { text, reload: body.reload === true }) }; }
      catch (error) { return { nodeId, saved: false, error: error instanceof Error ? error.message : String(error) }; }
    }) };
  }));
  router.post("/api/fleet/transfers/cancel", operation((body) => runtime.copyArtifact({ action: "cancel", copy_id: body.copyId })));
  const cache = new Map<string, { projects: unknown[]; updatedAt: string }>();
  router.get("/api/fleet/overview", async (_req, res) => {
    const nodes = await mapConcurrent(runtime.nodes(), 3, async (node) => {
      if (!node.online) return { nodeId: node.id, online: false, status: "offline", ...cache.get(node.id) };
      try {
        const reply = await runtime.request<ConsoleReply>(node.id, "console", { method: "GET", path: "/overview" }, 8000);
        if (reply.status !== 200) throw new Error("总览读取失败");
        const transfers = await runtime.request(node.id, "transfers.list", {}, 8000);
        const overview = reply.body as Record<string, unknown>;
        const latest = { projects: Array.isArray(overview.nodes) ? overview.nodes : [], updatedAt: new Date().toISOString() };
        cache.set(node.id, latest);
        return { nodeId: node.id, online: true, ...overview, transfers };
      } catch (error) {
        return { nodeId: node.id, online: false, status: "offline", ...cache.get(node.id), error: error instanceof Error ? error.message : String(error) };
      }
    });
    res.json({ nodes });
  });
  router.use("/api", async (req, res, next) => {
    const node = req.header("x-quaymesh-node");
    if (!node || node === runtime.localId || !req.path.startsWith("/projects")) { next(); return; }
    try {
      const reply = await runtime.request<ConsoleReply>(node, "console", { method: req.method, path: req.url, body: req.body });
      res.status(reply.status).json(reply.body);
    } catch (error) { res.status(503).json({ message: error instanceof Error ? error.message : String(error) }); }
  });
}
