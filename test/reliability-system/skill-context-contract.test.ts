import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { callOpen, createRealTestServer, structured } from "../session-card/server-fixture.js";

test("advertised skill tilde/absolute read and capture agree; unadvertised and symlink escapes fail", async t => {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  });

  let skill = "", outside = "";
  const server = await createRealTestServer({
    git: false,
    configure: async config => {
      const home = dirname(config.stateDir);
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      skill = join(home, ".codex", "skills", "advertised");
      outside = join(home, "private");
      mkdirSync(skill, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(skill, "SKILL.md"), "---\nname: advertised\ndescription: Fixture skill\n---\nfixture skill\n");
      writeFileSync(join(outside, "SKILL.md"), "synthetic secret");
      symlinkSync(outside, join(skill, "escape"), process.platform === "win32" ? "junction" : "dir");
      return { ...config, agentDir: join(home, ".codex"),
        skillPaths: [...config.skillPaths, join(home, ".codex", "skills")] };
    },
  });
  t.after(() => server.dispose());

  const meta = { "openai/session": "skill-read-contract" };
  const opened = structured(await callOpen(server.client, server.project, meta["openai/session"]));
  const read = (path:string) => server.client.callTool({ name: "read", arguments: {
    workspace_id: opened.workspace_id, path,
  }, _meta: meta });
  const capture = (path:string) => server.client.callTool({ name: "workspace_context", arguments: {
    workspace_id: opened.workspace_id, action: "capture", files: [{ path }],
  }, _meta: meta });
  const tilde = "~/.codex/skills/advertised/SKILL.md";
  const absolute = join(skill, "SKILL.md");
  const [shortRead, fullRead, short, full] = await Promise.all([
    read(tilde), read(absolute), capture(tilde), capture(absolute),
  ]);
  assert(!shortRead.isError, JSON.stringify(shortRead.content));
  assert(!fullRead.isError, JSON.stringify(fullRead.content));
  assert.deepEqual(shortRead.structuredContent?.result, fullRead.structuredContent?.result);
  assert(!short.isError, JSON.stringify(short.content));
  assert(!full.isError, JSON.stringify(full.content));
  const shortPage = short.structuredContent as { entries:Array<{lines:Array<{text:string}>}>;partial:boolean };
  const fullPage = full.structuredContent as typeof shortPage;
  assert.deepEqual(shortPage.entries[0]?.lines.map(line => line.text),
    fullPage.entries[0]?.lines.map(line => line.text));
  assert.equal(shortPage.partial, false);

  for (const path of ["~/private/SKILL.md", join(outside, "SKILL.md"),
    "~/.codex/skills/advertised/../../../private/SKILL.md",
    "~/.codex/skills/advertised/escape/SKILL.md"]) {
    const attemptedRead = await read(path);
    assert(attemptedRead.isError, JSON.stringify(attemptedRead.content));
    const attemptedCapture = await capture(path);
    assert(!attemptedCapture.isError);
    const report = attemptedCapture.structuredContent as { partial:boolean;entries:Array<{error?:string}> };
    assert.equal(report.partial, true);
    assert(report.entries[0]?.error);
    assert(!JSON.stringify(report).includes("synthetic secret"));
  }
});
