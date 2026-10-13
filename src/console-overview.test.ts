import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import { getLocalConsoleOverview } from "./console-overview.js";
import { WorkLedger } from "./work-ledger.js";

test("console overview returns bounded summaries without project detail payloads", () => {
  const directory = mkdtempSync(join(tmpdir(), "quaymesh-overview-"));
  const root = join(directory, "project");
  mkdirSync(join(root, ".git"), { recursive: true });
  const ledger = new WorkLedger(join(directory, "state"));
  try {
    const first = ledger.begin({ root, workspaceId: "ws-overview", workItemId: "item", runKey: "run", title: "概要测试任务", origin: { entryPoint: "console", evidence: "server_entry" } });
    const config = { stateDir: join(directory, "state"), allowedRoots: [root], federation: { nodeId: "test-node" } } as ServerConfig;
    const overview = getLocalConsoleOverview(ledger, config);
    assert.equal(overview.nodes[0]?.nodeId, "test-node");
    assert.equal(overview.counters.projects, 1);
    assert.equal(overview.counters.tasks, 1);
    assert.equal(overview.counters.activeTasks, 1);
    assert.equal(overview.recentRuns.length, 1);
    assert.equal((overview.recentRuns[0] as { projectId: string }).projectId, first.project_id);
    assert.equal("evidence" in (overview.recentRuns[0] as object), false);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
