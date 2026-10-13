import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const scripts = [
  "apps/native/windows/build.ps1",
  "build.ps1",
  "node/windows-install.ps1",
  "node/windows-stop.ps1",
  "scripts/build-windows.ps1",
  "scripts/test-windows-console.ps1",
  "scripts/verify-windows.ps1",
  "scripts/windows-easytier-cutover.ps1",
];

test("Windows PowerShell 5.1 can identify UTF-8 source containing Chinese text", () => {
  for (const script of scripts) {
    const content = readFileSync(resolve(script));
    if (content.some(byte => byte > 127)) {
      assert.deepEqual([...content.subarray(0, 3)], [0xef, 0xbb, 0xbf], script);
    }
  }
});

test("All deployed PowerShell scripts parse in the native Windows engine",
  { skip: process.platform !== "win32" }, () => {
    for (const script of scripts) {
      const filename = resolve(script).replaceAll("'", "''");
      const expression = [
        "$tokens=$null;$errors=$null;",
        `[System.Management.Automation.Language.Parser]::ParseFile('${filename}',[ref]$tokens,[ref]$errors)|Out-Null;`,
        "if($errors.Count){$errors|Out-String|Write-Error;exit 1}",
      ].join("");
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", expression], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 0, `${script}: ${result.stderr || result.stdout}`);
    }
  });
