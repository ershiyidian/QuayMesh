import {spawnSync} from "node:child_process";
import {access, chmod, mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {parseArgs} from "node:util";

// Run against the actual compiled package/release, never an isolated dist file.
// No enrolled client, real credential vault, IPC listener or service is used.
const assert = (condition, code) => {if (!condition) throw new Error(code);};
let directory;
const cases = [];
try {
  const {values} = parseArgs({options: {root: {type: "string"}, node: {type: "string"}}, strict: true});
  assert(values.root && values.node, "USAGE_REQUIRE_ROOT_AND_NODE");
  const root = resolve(values.root), executable = resolve(values.node);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert(manifest.bin?.quaymesh === "bin/quaymesh.js", "PACKAGE_BIN_MISMATCH");
  const entry = join(root, "bin", "quaymesh.js");
  await Promise.all([access(entry), access(executable), access(join(root, "dist", "local-user-api", "cli.js"))]);
  directory = await mkdtemp(join(tmpdir(), "qm-installed-cli-"));
  await chmod(directory, 0o700);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && !/^QUAYMESH_/i.test(key) && !/^(NODE_OPTIONS|NODE_PATH)$/i.test(key)));

  const run = (name, args, expectedCode, expectedError, input = "") => {
    const result = spawnSync(executable, [entry, ...args], {
      cwd: directory, env, input, encoding: "utf8", windowsHide: true,
      timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 65_536,
    });
    assert(!result.error && !result.signal, name + "_PROCESS_FAILED");
    assert(result.status === expectedCode, name + "_EXIT_CODE");
    if (expectedError) {
      assert(result.stdout.trim() === "", name + "_UNEXPECTED_STDOUT");
      let body;
      try {body = JSON.parse(result.stderr.trim());} catch {throw new Error(name + "_NOT_JSON_ERROR");}
      assert(body?.ok === false && body.error?.code === expectedError, name + "_WRONG_ERROR");
      assert(body.error.effect === "not_started", name + "_WRONG_EFFECT");
    } else {
      assert(result.stderr.trim() === "", name + "_UNEXPECTED_STDERR");
      assert(result.stdout.includes("quaymesh local tasks") && result.stdout.includes("--json"), name + "_HELP_MISSING");
    }
    assert(!/qml1_[A-Za-z0-9_-]{43}/.test(result.stdout + result.stderr), name + "_CREDENTIAL_OUTPUT");
    cases.push({name, passed: true, exitCode: result.status, errorCode: expectedError ?? null});
  };

  run("installed_local_help", ["local", "--help"], 0);
  run("installed_json_status", ["local", "status", "--json", "--config-dir", directory], 1, "LOCAL_API_CLIENT_REQUIRED");
  run("installed_leading_json", ["--json", "local", "status", "--config-dir", directory], 1, "LOCAL_API_CLIENT_REQUIRED");
  run("installed_reject_source_identity", ["local", "status", "--json", "--source-task-id", "forbidden"], 1, "LOCAL_API_INVALID_ARGUMENT");
  run("installed_import_stdin_validation", ["client", "import", "smoke", "--stdin", "--json", "--config-dir", directory], 1,
    "LOCAL_API_INVALID_ARGUMENT", "{");
  assert((await readdir(directory)).length === 0, "UNEXPECTED_CONFIG_OR_CREDENTIAL_FILE");
  console.log(JSON.stringify({ok: true, root, node: executable, cases, servicesStarted: false, realCredentialsUsed: false}));
} catch (error) {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "INSTALLED_CLI_SMOKE_FAILED";
  console.error(JSON.stringify({ok: false, code, cases}));
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, {recursive: true, force: true});
}
