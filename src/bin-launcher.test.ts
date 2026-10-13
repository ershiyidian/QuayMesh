import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTestQuayMeshConfig } from "./test-support/config.test.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxRoot = join(projectRoot, "node_modules", "tsx");

for (const entrypoint of [
  {
    bin: "quaymesh-agentd.js",
    source: "src/local-agent-daemon-main.ts",
    dist: "dist/local-agent-daemon-main.js",
  },
]) {
  testLauncher(entrypoint);
}

testNodeSupervisorLauncher();
testLinkedCheckoutReadsCurrentConfig();
testMissingSourceRuntimeFailsClosed();

// The public command is a Node supervisor; the older TypeScript CLI is only
// entered explicitly through `quaymesh core ...`.
function testNodeSupervisorLauncher(): void {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-node-launcher-test-"));
  try {
    cpSync(join(projectRoot, "bin"), join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "node"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, "node", "cli.mjs"), 'export async function main(){console.log("node-supervisor");}\n');
    writeFileSync(join(root, "dist", "cli.js"), 'console.log("stale-core");\n');
    assert.equal(execFileSync(process.execPath, [join(root, "bin", "quaymesh.js")], { encoding: "utf8" }).trim(), "node-supervisor");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

function testLinkedCheckoutReadsCurrentConfig(): void {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-bin-config-test-"));
  try {
    const env = writeTestQuayMeshConfig(root, { tools: { mode: "codex" } });
    const output = execFileSync(process.execPath, [join(projectRoot, "bin", "quaymesh.js"), "core", "config", "get"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    const config = JSON.parse(output) as { tools?: { mode?: string } };
    assert.equal(config.tools?.mode, "codex");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testMissingSourceRuntimeFailsClosed(): void {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-bin-missing-tsx-test-"));
  try {
    cpSync(join(projectRoot, "bin"), join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, "src", "local-agent-daemon-main.ts"), 'console.log("source");\n');
    writeFileSync(join(root, "dist", "local-agent-daemon-main.js"), 'console.log("stale-dist");\n');

    assert.throws(
      () => execFileSync(process.execPath, [join(root, "bin", "quaymesh-agentd.js")], { encoding: "utf8", stdio: "pipe" }),
      /source checkout.*tsx.*pnpm install/is,
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

function testLauncher(entrypoint: { bin: string; source: string; dist: string }): void {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-bin-launcher-test-"));
  try {
    cpSync(join(projectRoot, "bin"), join(root, "bin"), { recursive: true });
    mkdirSync(dirname(join(root, entrypoint.source)), { recursive: true });
    mkdirSync(dirname(join(root, entrypoint.dist)), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(tsxRoot, join(root, "node_modules", "tsx"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, entrypoint.source), 'console.log("source");\n');
    writeFileSync(join(root, entrypoint.dist), 'console.log("dist");\n');

    const sourceOutput = execFileSync(process.execPath, [join(root, "bin", entrypoint.bin)], {
      encoding: "utf8",
    }).trim();
    assert.equal(sourceOutput, "source", `${entrypoint.bin} must prefer source in a linked checkout`);

    rmSync(join(root, entrypoint.source));
    const packagedOutput = execFileSync(process.execPath, [join(root, "bin", entrypoint.bin)], {
      encoding: "utf8",
    }).trim();
    assert.equal(packagedOutput, "dist", `${entrypoint.bin} must use dist in a published package`);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}
