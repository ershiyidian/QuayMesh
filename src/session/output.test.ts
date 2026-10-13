import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionOutputStore } from "./output.js";

test("output cursors preserve UTF-8 across byte-bounded pages and independent readers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-output-"));
  const store = new SessionOutputStore(directory, 64);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.open("session-a", "command-a", "op_a");
  const bytes = Buffer.from("ASCII 中文 😀\n第二行\n", "utf8");
  const split = 3;
  await store.append("command-a", bytes.subarray(0, split));
  await store.append("command-a", bytes.subarray(split));
  await store.finish("command-a", 0, null);

  let cursor = 0;
  let model = "";
  while (true) {
    const page = await store.modelRead("session-a", "command-a", cursor, 5);
    model += page.chunk;
    cursor = page.nextCursor;
    if (page.done) break;
    assert.ok(page.chunk.length > 0 || page.truncated);
  }
  assert.equal(model, bytes.toString("utf8"));

  let uiCursor = 0;
  let ui = "";
  while (true) {
    const page = await store.uiRead("session-a", "command-a", uiCursor, 7);
    ui += page.chunk;
    uiCursor = page.nextCursor;
    if (page.done) break;
  }
  assert.equal(ui, bytes.toString("utf8"));
  assert.equal(model, bytes.toString("utf8"));
});

test("output retention reports the first retained byte after truncation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-output-"));
  const store = new SessionOutputStore(directory, 16);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.open("session-a", "command-b", "op_b");
  await store.append("command-b", "0123456789ABCDEFGHIJKLMN");
  await store.finish("command-b", 1, null);
  const page = await store.read("session-a", "command-b", 0, 128, "ui");
  assert.equal(page.truncated, true);
  assert.ok(page.retainedFrom > 0);
  assert.equal(page.totalBytes, 24);
  assert.equal(page.chunk.includes("K"), true);
});

test("分段输出跨越保留上限后，磁盘占用有界且不会重写整个窗口", async t => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-output-segments-"));
  const limit = 256 * 1024;
  const store = new SessionOutputStore(directory, limit);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.open("session", "command", "operation");
  const block = "abcdef中文😀\n".repeat(4096);
  let total = 0;
  for (let index = 0; index < 40; index++) {
    await store.append("command", block);
    total += Buffer.byteLength(block);
  }
  await store.finish("command", 0, null);
  const metadata = JSON.parse(await readFile(join(directory, "session-output", "command.json"), "utf8"));
  assert.equal(metadata.version, 3);
  assert.equal(metadata.state, "ready");
  assert.equal(metadata.total_bytes, total);
  assert.ok(metadata.segments.length <= 5);
  const files = await readdir(join(directory, "session-output", "command"));
  assert.ok(files.length <= 5);
  let diskBytes = 0;
  for (const file of files) diskBytes += (await stat(join(directory, "session-output", "command", file))).size;
  assert.ok(diskBytes <= limit + 64 * 1024);
  const page = await store.read("session", "command", 0, limit, "ui");
  assert.equal(page.truncated, true);
  assert.equal(page.done, true);
  assert.equal(page.totalBytes, total);
  assert.ok(!page.chunk.includes("�"));
});

test("并发追加和结束按命令串行，单字节读取仍能取得完整中文字符", async t => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-output-serialized-"));
  const store = new SessionOutputStore(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.open("session", "command", "operation");
  const writes = [store.append("command", "中"), store.append("command", "文"), store.append("command", "😀")];
  const finish = store.finish("command", 0, null);
  await Promise.all([...writes, finish]);
  let cursor = 0, text = "";
  for (let i = 0; i < 3; i++) {
    const page = await store.read("session", "command", cursor, 1, "model");
    assert.ok(page.nextCursor > cursor);
    cursor = page.nextCursor; text += page.chunk;
  }
  assert.equal(text, "中文😀");
  assert.equal((await store.read("session", "command", cursor, 1, "ui")).done, true);
});

test("跨段 UTF-8 读取与关闭等待使用实际文件", async t => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-output-cross-segment-"));
  const store = new SessionOutputStore(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await store.open("session", "command", "operation");
  const text = "a".repeat(65535) + "中文😀tail";
  const append = store.append("command", text);
  await store.close(); await append;
  const reader = new SessionOutputStore(directory);
  try {
    const page = await reader.read("session", "command", 65535, 100, "ui");
    assert.equal(page.chunk, "中文😀tail");
  } finally { await reader.close(); }
});

test("实际文件写入失败会拒绝追加和结束，不发布成功结果", async t => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-output-write-error-"));
  const store = new SessionOutputStore(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.open("session", "command", "operation");
  await mkdir(join(directory, "session-output", "command", "segment-0.bin"));
  await assert.rejects(store.append("command", "actual output"));
  await assert.rejects(store.finish("command", 0, null));
  const metadata = JSON.parse(await readFile(join(directory, "session-output", "command.json"), "utf8"));
  assert.equal(metadata.done, false);
  assert.equal(metadata.total_bytes, 0);
});
