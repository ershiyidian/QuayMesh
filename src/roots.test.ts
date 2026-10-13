import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertAllowedPath, canonicalPathIdentity, expandHomePath, normalizeWslPath, resolveAllowedPath } from "./roots.js";

const home = homedir();

const wslProject = "\\\\wsl.localhost\\ubuntu\\home\\owner\\OpenViking";
assert.equal(normalizeWslPath("\\\\wsl$\\Ubuntu\\home\\owner\\OpenViking"), wslProject);
assert.equal(normalizeWslPath("\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\owner\\OpenViking"), wslProject);
assert.equal(normalizeWslPath("//WSL.LOCALHOST/Ubuntu/home/owner/OpenViking"), wslProject);
assert.equal(normalizeWslPath("C:\\Project\\OpenViking"), undefined);
assert.equal(normalizeWslPath("\\\\server\\share\\OpenViking"), undefined);

assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/quaymesh"), resolve(home, "personal", "quaymesh"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/quaymesh", [join(home, "personal")]),
  resolve(home, "personal", "quaymesh"),
);

assert.equal(
  assertAllowedPath("~/personal/quaymesh", ["~/personal"]),
  resolve(home, "personal", "quaymesh"),
);

assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  resolve("/workspace", "~/file.txt"),
);

if (process.platform === "win32") {
  assert.equal(canonicalPathIdentity(wslProject), wslProject);
  assert.equal(canonicalPathIdentity("C:\\Project\\OpenViking"), "c:\\project\\openviking");
  assert.equal(assertAllowedPath("\\\\wsl$\\Ubuntu\\home\\owner\\OpenViking\\src", [wslProject]), "\\\\wsl$\\Ubuntu\\home\\owner\\OpenViking\\src");
  for (const outside of [wslProject.toLowerCase(), `${wslProject}Other`, `${wslProject}\\..\\other`, wslProject.replace("ubuntu", "Debian")]) {
    assert.throws(() => assertAllowedPath(outside, [wslProject]), /outside allowed roots/);
  }
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\quaymesh"]),
    /Path is outside allowed roots/,
  );
}
