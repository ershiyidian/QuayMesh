import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));

test("Core imports and disabled skills leave Pi unloaded; concurrent first reads still use the real library", async t => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-pi-lazy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "sample.txt");
  await writeFile(path, 'lazy-read-smoke 中文 "引号"\n', "utf8");
  const script = `
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    import {pathToFileURL} from 'node:url';
    import {join} from 'node:path';
    const [repository,directory,path]=process.argv.slice(1);
    const piEntry=import.meta.resolve('@earendil-works/pi-coding-agent');
    const loaded=new Set();let barrelLoads=0;
    const hooks=registerHooks({load(url,context,nextLoad){
      const result=nextLoad(url,context);
      if(url.includes('/@earendil-works/pi-coding-agent/')) {
        loaded.add(url);
        if(url===piEntry)barrelLoads++;
      }
      return result;
    }});
    try {
      await import(pathToFileURL(join(repository,'src/server.ts')).href);
      const {loadWorkspaceSkills}=await import(pathToFileURL(join(repository,'src/skills.ts')).href);
      const {readFileTool}=await import(pathToFileURL(join(repository,'src/pi-tools.ts')).href);
      assert.equal(loaded.size,0,'Core startup must not load the Pi package');
      assert.deepEqual(await loadWorkspaceSkills({skillsEnabled:false},directory),{skills:[],diagnostics:[]});
      assert.equal(loaded.size,0,'disabled skill discovery must stay cheap');
      const results=await Promise.all([readFileTool({path},{cwd:directory}),readFileTool({path},{cwd:directory})]);
      for(const result of results) {
        assert.notEqual(result.isError,true);
        assert.ok(result.content.some(block=>block.type==='text'&&block.text.includes('lazy-read-smoke 中文 "引号"')));
      }
      assert.ok(loaded.size>0,'the first actual read must execute the real Pi implementation');
      assert.equal(barrelLoads,1,'concurrent callers share the native ESM module cache');
      console.log(JSON.stringify({before_use_pi_modules:0,after_read_pi_modules:loaded.size,barrel_loads:barrelLoads}));
    } finally {hooks.deregister();}
  `;
  const result = await run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, repository, directory, path], {
    cwd: repository, env: { ...process.env, QUAYMESH_CONFIG_DIR: join(directory, "config") },
    timeout: 45_000, maxBuffer: 1024 * 1024,
  });
  const observation = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
  assert.equal(observation.before_use_pi_modules, 0);
  assert.ok(observation.after_read_pi_modules > 0);
  assert.equal(observation.barrel_loads, 1);
});
