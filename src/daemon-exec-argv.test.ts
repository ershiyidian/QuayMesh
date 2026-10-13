import assert from "node:assert/strict";
import test from "node:test";
import { daemonExecArgv } from "./local-agent-client.js";

test("daemon inherits loaders but never a caller eval, print or input entry mode", () => {
  assert.deepEqual(daemonExecArgv(["--import", "tsx", "--input-type=module", "-e", "spawnAgain()"]),
    ["--import", "tsx"]);
  assert.deepEqual(daemonExecArgv(["--eval=private()", "--print", "secret", "--input-type", "module"]), []);
  assert.deepEqual(daemonExecArgv(["-p42", "--check", "--test", "--inspect=127.0.0.1:9229", "--no-warnings"]),
    ["--no-warnings"]);
});
