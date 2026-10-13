import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface CodexReference {
  codexVersion: string;
  sourceRevision: string;
  generatedAt: string;
  protocolGenerator: {
    executable: string;
    args: {
      generateTs: string[];
      generateJsonSchema: string[];
    };
  };
  sources: Record<string, string>;
  adoptedBehavior: string[];
  intentionallyDifferent: string[];
}

async function runCommand(executable: string, args: string[]): Promise<string> {
  const isWindowsCmd = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
  const { stdout } = await execFileAsync(executable, args, {
    encoding: "utf8",
    shell: isWindowsCmd,
    windowsHide: true,
  });
  return stdout;
}

async function fixTsExtensionsInDir(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await fixTsExtensionsInDir(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      let content = await readFile(fullPath, "utf8");
      // Replace: from "./something" or from "../something" where it doesn't already have an extension
      const updated = content.replace(/(from\s+["'])(\.\.?[^"']+)(["'])/g, (match, p1, p2, p3) => {
        if (p2.endsWith(".js") || p2.endsWith(".json")) {
          return match;
        }
        return `${p1}${p2}.js${p3}`;
      });
      if (updated !== content) {
        await writeFile(fullPath, updated, "utf8");
      }
    }
  }
}

async function createSubmoduleBarrels(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subDir = join(dir, entry.name);
      const subEntries = await readdir(subDir, { withFileTypes: true });
      const barrelFile = join(dir, `${entry.name}.ts`);
      const exportLines: string[] = [];
      for (const sub of subEntries) {
        if (sub.isFile() && sub.name.endsWith(".ts") && sub.name !== "index.ts") {
          const modName = sub.name.replace(/\.ts$/, "");
          exportLines.push(`export * from "./${entry.name}/${modName}.js";`);
        }
      }
      if (exportLines.length > 0) {
        await writeFile(barrelFile, exportLines.join("\n") + "\n", "utf8");
      }
      await createSubmoduleBarrels(subDir);
    }
  }
}

async function compareDirectories(actualDir: string, expectedDir: string): Promise<string[]> {
  const diffs: string[] = [];
  if (!existsSync(expectedDir)) {
    diffs.push(`Expected directory does not exist: ${expectedDir}`);
    return diffs;
  }

  async function walk(currentActual: string, currentExpected: string, rel: string = ""): Promise<void> {
    const actualEntries = await readdir(currentActual, { withFileTypes: true });
    const expectedEntries = await readdir(currentExpected, { withFileTypes: true });

    const expectedMap = new Map(expectedEntries.map((e) => [e.name, e]));
    for (const actualEntry of actualEntries) {
      const relPath = rel ? `${rel}/${actualEntry.name}` : actualEntry.name;
      const expectedEntry = expectedMap.get(actualEntry.name);
      if (!expectedEntry) {
        diffs.push(`Extra file in generated: ${relPath}`);
        continue;
      }
      expectedMap.delete(actualEntry.name);

      if (actualEntry.isDirectory()) {
        if (!expectedEntry.isDirectory()) {
          diffs.push(`Type mismatch for ${relPath}: expected directory`);
        } else {
          await walk(
            join(currentActual, actualEntry.name),
            join(currentExpected, expectedEntry.name),
            relPath,
          );
        }
      } else {
        const actualContent = await readFile(join(currentActual, actualEntry.name));
        const expectedContent = await readFile(join(currentExpected, expectedEntry.name));
        if (!actualContent.equals(expectedContent)) {
          diffs.push(`Content mismatch: ${relPath}`);
        }
      }
    }

    for (const [missingName] of expectedMap) {
      const relPath = rel ? `${rel}/${missingName}` : missingName;
      diffs.push(`Missing file in generated: ${relPath}`);
    }
  }

  await walk(actualDir, expectedDir);
  return diffs;
}

export async function generateCodexProtocol(options: { check?: boolean } = {}): Promise<void> {
  const refPath = resolve(process.cwd(), "tools", "codex-reference.json");
  if (!existsSync(refPath)) {
    throw new Error(`Reference metadata file not found at ${refPath}`);
  }

  const ref: CodexReference = JSON.parse(await readFile(refPath, "utf8"));
  const executable = ref.protocolGenerator.executable;
  const expectedVersion = ref.codexVersion;

  // 1. Verify exact version
  const versionOutput = await runCommand(executable, ["--version"]);
  const versionMatch = versionOutput.trim().match(/v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
  const actualVersion = versionMatch?.[1];
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Codex version mismatch: expected ${expectedVersion}, got ${actualVersion} (${versionOutput.trim()})`,
    );
  }

  // 2. Probe generator help
  await runCommand(executable, ["app-server", "generate-ts", "--help"]);
  await runCommand(executable, ["app-server", "generate-json-schema", "--help"]);

  // 3. Create isolated temp directory
  const tempBase = join(tmpdir(), `codex-gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const tempTsDir = join(tempBase, "ts");
  const tempSchemaDir = join(tempBase, "schema");
  await mkdir(tempTsDir, { recursive: true });
  await mkdir(tempSchemaDir, { recursive: true });

  try {
    // 4. Run generators
    await runCommand(executable, ["app-server", "generate-ts", "--out", tempTsDir]);
    await runCommand(executable, ["app-server", "generate-json-schema", "--out", tempSchemaDir]);

    const tsFiles = await readdir(tempTsDir);
    const schemaFiles = await readdir(tempSchemaDir);
    if (tsFiles.length === 0 || schemaFiles.length === 0) {
      throw new Error("Generated artifacts are empty");
    }

    // Fix ESM relative import specifiers and generate subfolder barrels for NodeNext resolution
    await createSubmoduleBarrels(tempTsDir);
    await fixTsExtensionsInDir(tempTsDir);

    const targetGeneratedDir = resolve(process.cwd(), "src", "codex", "generated");

    if (options.check) {
      const diffs = await compareDirectories(tempTsDir, targetGeneratedDir);
      if (diffs.length > 0) {
        console.error("Generated Codex protocol differs from target tree:");
        for (const diff of diffs) {
          console.error(`  - ${diff}`);
        }
        process.exitCode = 1;
        return;
      }
      console.log("Codex protocol check passed: tree matches generated artifacts.");
    } else {
      await rm(targetGeneratedDir, { recursive: true, force: true });
      await mkdir(targetGeneratedDir, { recursive: true });
      await cp(tempTsDir, targetGeneratedDir, { recursive: true });

      ref.generatedAt = new Date().toISOString();
      await writeFile(refPath, `${JSON.stringify(ref, null, 2)}\n`, "utf8");
      console.log(`Generated TypeScript bindings into ${targetGeneratedDir}`);
    }
  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const isCheck = process.argv.includes("--check");
  generateCodexProtocol({ check: isCheck }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}