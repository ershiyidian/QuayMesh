import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalAgentStore } from "../local-agent-store.js";
import { WorkLedger } from "../work-ledger.js";
import { readAgentResultPage } from "./agent-results.js";

test("agent result pages keep the saved execution when another turn completes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quaymesh-agent-results-"));
  const project = join(root, "project");
  await mkdir(project);
  const state = join(root, "state");
  const agents = new LocalAgentStore(state);
  const ledger = new WorkLedger(state);
  t.after(async () => { ledger.close(); agents.close(); await rm(root, { recursive: true, force: true }); });
  const agent = agents.create({ workspaceId: "ws", workspaceRoot: project, profileName: "reviewer", provider: "codex" });
  const run = ledger.begin({ root: project, workspaceId: "ws", workItemId: "result-pages", runKey: "first", title: "Read saved results",
    origin: { entryPoint: "chatgpt_mcp", evidence: "client_reported" } });
  const first = ledger.beginExecution({ runId: run.id, agentId: agent.id, provider: "codex" });
  const text = "保留原始结果。saved result\n".repeat(3000);
  ledger.saveResponse(first, text);
  ledger.endExecution(first, "completed");
  const runs = new Set([run.id]);
  const page = readAgentResultPage(ledger, runs, [agent.id], [agent.id]);
  assert.ok(page.cursor);
  assert.ok(Buffer.byteLength(page.text, "utf8") <= 12 * 1024);
  const second = ledger.beginExecution({ runId: run.id, agentId: agent.id, provider: "codex" });
  ledger.saveResponse(second, "A later independent response");
  ledger.endExecution(second, "completed");
  let combined = page.text;
  let cursor: string | null = page.cursor;
  while (cursor) {
    const next = readAgentResultPage(ledger, runs, [agent.id], [agent.id], cursor);
    assert.ok(Buffer.byteLength(next.text, "utf8") <= 12 * 1024);
    assert.equal(next.references[agent.id], `execution:${first}`);
    combined += next.text;
    cursor = next.cursor;
  }
  assert.equal(combined, `[${agent.id}]\n${text}`);
  assert.throws(() => readAgentResultPage(ledger, new Set(), [agent.id], [], page.cursor!), /RESULT_CURSOR_SCOPE_MISMATCH/);
});
