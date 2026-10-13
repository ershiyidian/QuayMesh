import { CodexAppServerRuntime, codexCommandEnvironment, resolveCodexCommand } from "./local-agent-codex.js";
import { quotaPreflight } from "./codex-quota-preflight.js";

const env = codexCommandEnvironment();
const command = resolveCodexCommand(env);
if (!command) throw new Error("Configured Codex executable unavailable");
const runtime = new CodexAppServerRuntime({ command: command.executable, env, version: command.version });
try {
  await runtime.initialize();
  console.log(JSON.stringify({ ...quotaPreflight(await runtime.control("account/rateLimits/read", {})), version: command.version }));
} finally { await runtime.close(); }
