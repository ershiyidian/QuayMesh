import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";

const snapshot = getLocalAgentProviderAvailabilitySnapshot({
  ...process.env,
  CODEX_COMMAND: "/definitely/missing/quaymesh-codex",
});
assert.deepEqual(snapshot.find((provider) => provider.name === "codex"), {
  name: "codex",
  available: false,
  verification: "unavailable",
  reason: "/definitely/missing/quaymesh-codex executable not found",
});
assert.equal(
  getLocalAgentProviderAvailabilitySnapshot({ ...process.env, CODEX_COMMAND: "" })
    .find((provider) => provider.name === "codex")?.available,
  false,
);

{
  const directory = mkdtempSync(join(tmpdir(), "quaymesh-provider-command-"));
  const executable = join(directory, process.platform === "win32" ? "codex-wrapper.cmd" : "codex-wrapper");
  try {
    assert.equal(
      getLocalAgentProviderAvailabilitySnapshot({
        ...process.env,
        CODEX_COMMAND: directory,
      }).find((provider) => provider.name === "codex")?.available,
      false,
    );
    writeFileSync(executable,process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    const availability = getLocalAgentProviderAvailabilitySnapshot(
      {
        ...process.env,
        CODEX_COMMAND: "/definitely/missing/quaymesh-codex",
        OPENAI_API_KEY: "must-not-appear",
      },
      {
        enabled: true,
        instructions: "on-demand",
        providers: [{
          id: "codex",
          enabled: true,
          command: executable,
          env: { OPENAI_API_KEY: "configured-secret", EMPTY_VALUE: "" },
        }],
      },
    ).find((provider) => provider.name === "codex");
    assert.equal(availability?.name,"codex");
    assert.equal(availability?.available,true);
    assert.equal(availability?.verification,"command_resolved");
    assert.equal(availability?.accountVerified,false,"命令可执行不代表账户认证通过");
    assert.equal(typeof availability?.executable,"string");
    assert.doesNotMatch(JSON.stringify(availability), /configured-secret|must-not-appear/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
