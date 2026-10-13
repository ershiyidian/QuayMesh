import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { WorkLedger } from "./work-ledger.js";
import { ensureSavedDesktopProject } from "./codex-desktop-open.js";
import { CodexAppServerRuntime, codexCommandEnvironment, resolveCodexCommand } from "./local-agent-codex.js";
import { connectDesktopProjects, desktopHome, prepareProjectRoots, projectPathKey, registerProject, type ProjectControl } from "./codex-projects.js";

// Standalone source entry: pnpm exec tsx src/codex-project-cli.ts --root <path> ...
// No existing server/daemon/Desktop restart, and no model invocation.
const { values } = parseArgs({ options: {
  root: { type: "string", multiple: true }, create: { type: "boolean", default: false },
  "run-id": { type: "string" }, "thread-id": { type: "string", multiple: true },
}, strict: true });
if (!values.root?.length) throw new Error("--root is required; --create explicitly authorizes missing directories.");
const config = loadConfig();
const prepared = await prepareProjectRoots(values.root, config.allowedRoots, values.create);
const ledger = new WorkLedger(config.stateDir);
const store = createWorkspaceStore(config.stateDir);
let client: ProjectControl | undefined;
let identityRuntime: CodexAppServerRuntime | undefined;
try {
  const threads = new Set(values["thread-id"] ?? []);
  let managed: ReturnType<WorkLedger["thread"]>[] = [];
  if (values["run-id"]) {
    const run = ledger.run(values["run-id"]);
    if (ledger.project(prepared.roots[0]!).id !== run.project_id) throw new Error("Run belongs to another QuayMesh project.");
    managed = ledger.executions(run.id).flatMap((execution) => execution.managed_thread_id ? [ledger.thread(execution.managed_thread_id)] : []);
    if (!managed.length) throw new Error("No ledger thread identity found for this run; refusing to guess.");
    managed.forEach((entry) => threads.add(entry.thread_id));
    const command = resolveCodexCommand();
    if (!command) throw new Error("Cannot verify the original provider instance.");
    identityRuntime = new CodexAppServerRuntime({ command: command.executable, env: codexCommandEnvironment(), version: command.version });
    await identityRuntime.initialize();
    const identity = await identityRuntime.identity(true);
    if (!identity.identityVerified || managed.some((entry) => !entry.identity_verified || entry.instance_id !== identity.instanceId)) {
      throw new Error("Ledger provider instance does not match the current provider. No thread metadata changed.");
    }
  }
  client = await connectDesktopProjects();
  if (projectPathKey(client.home) !== projectPathKey(desktopHome())) throw new Error("Desktop provider home mismatch; no client workspace was opened.");
  const savedClient = await ensureSavedDesktopProject(prepared.roots, desktopHome(), projectPathKey);
  const desktopCatalog = savedClient.catalog;
  const historyFiles = new Map<string, string>();
  for (const threadId of threads) {
    const response = await client.request("thread/read", { threadId, includeTurns: false }) as { thread: { id: string; path: string } };
    if (response.thread.id !== threadId || typeof response.thread.path !== "string") throw new Error("Cannot verify original history path.");
    historyFiles.set(threadId, response.thread.path);
  }
  const history = async () => Promise.all([...historyFiles].map(async ([threadId, path]) => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return { threadId, sha256: hash.digest("hex") };
  }));
  const ledgerHash = () => createHash("sha256").update(JSON.stringify(managed.map((entry) => ({
    thread: ledger.thread(entry.id),
    usage: ledger.db.prepare("select * from agent_usage_snapshots where agent_id=? order by rowid").all(entry.agent_id),
    agent: ledger.db.prepare("select * from local_agent_sessions where id=?").get(entry.agent_id),
  })))).digest("hex");
  const before = { history: await history(), ledgerSha256: ledgerHash() };
  const evidenceDir = join(config.stateDir, "project-registration");
  await mkdir(evidenceDir, { recursive: true });
  const evidencePath = join(evidenceDir, `${randomUUID()}.json`);
  // Persist scoped pre-write evidence first. No chat text, global state or credentials.
  await writeFile(evidencePath, JSON.stringify({ before }, null, 2), { flag: "wx", mode: 0o600 });
  const workspace = await new WorkspaceRegistry(config, store).openWorkspace(prepared.roots[0]!, {
    conversationScopeId: "quaymesh-project-registration-cli",
  });
  const receipt = await registerProject(client, { roots: prepared.roots, expectedHome: desktopHome(), threadIds: [...threads], desktopCatalog });
  receipt.createdDirectories = prepared.createdDirectories;
  receipt.clientCreation = savedClient.creation;
  const after = { history: await history(), ledgerSha256: ledgerHash() };
  const output = { workspaceId: workspace.workspace.id, quaymeshProjectId: ledger.project(prepared.roots[0]!).id,
    ...receipt, providerInstanceIds: [...new Set(managed.map((entry) => entry.instance_id))],
    preservation: { unchanged: JSON.stringify(before) === JSON.stringify(after), before, after }, evidencePath };
  await writeFile(evidencePath, JSON.stringify(output, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(output, null, 2));
  if (receipt.status !== "persisted_registration" || !output.preservation.unchanged) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ status: "partial", roots: prepared.roots, createdDirectories: prepared.createdDirectories,
    uiStatus: "unverified", code: "PROJECT_REPAIR_PARTIAL",
    action: error instanceof Error ? error.message : "Re-observe project and thread identity before retrying." }, null, 2));
  process.exitCode = 1;
} finally {
  await client?.close();
  await identityRuntime?.close();
  store.close?.(); ledger.close();
}
