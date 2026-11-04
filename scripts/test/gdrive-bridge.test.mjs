import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBridge } from "../gdrive-bridge.mjs";

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "quaymesh-gdrive-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("encode/decode preserve binary bytes and reject malformed or oversized input without overwriting", async t => {
  const dir = await directory(t), source = join(dir, "source.bin"), out = join(dir, "decoded.bin");
  const bytes = Buffer.from([0, 255, 128, 1, 10, 13, 77]);
  await writeFile(source, bytes);
  const encoded = await runBridge(["encode", "--file", source]);
  assert.equal(encoded.size, bytes.length);
  await runBridge(["decode", "--base64", encoded.content_base64, "--out", out, "--sha256", encoded.sha256]);
  assert.deepEqual(await readFile(out), bytes);
  await assert.rejects(runBridge(["decode", "--base64", "A", "--out", join(dir, "invalid")]), /Invalid base64/u);
  await assert.rejects(runBridge(["decode", "--base64", "Yg==", "--out", out]), { code: "EEXIST" });
  assert.deepEqual(await readFile(out), bytes);
  await assert.rejects(runBridge(["encode", "--file", source, "--chunk-bytes", "3"]), /Unknown option/u);
  await writeFile(source, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(runBridge(["encode", "--file", source]), /up to 1 MiB/u);
  assert.deepEqual((await readdir(dir)).sort(), ["decoded.bin", "source.bin"]);
});

test("Drive upload streams bounded chunks and resumes from the server-confirmed byte after interruption", async t => {
  const dir = await directory(t), source = join(dir, "large.bin");
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 123);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await writeFile(source, bytes);
  const chunks = [];
  let probe = false, firstPut = true;
  const fetch = async (input, init) => {
    assert.equal(init.headers.Authorization, "Bearer test-token");
    assert.ok(init.signal instanceof AbortSignal);
    if (init.method === "POST") {
      assert.deepEqual(JSON.parse(init.body), { name: "large.bin", parents: ["test_folder_123"] });
      return new Response(null, { status: 200, headers: { Location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=test" } });
    }
    const range = init.headers["Content-Range"];
    if (range.startsWith("bytes */")) {
      probe = true;
      return new Response(null, { status: 308, headers: { Range: "bytes=0-262143" } });
    }
    assert.ok(init.body instanceof Blob);
    assert.ok(init.body.size <= 8 * 1024 * 1024);
    const data = Buffer.from(await init.body.arrayBuffer());
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(range);
    assert.ok(match);
    const start = Number(match[1]), end = Number(match[2]);
    assert.deepEqual(data, bytes.subarray(start, end + 1));
    if (firstPut) {
      firstPut = false;
      chunks.push(data.subarray(0, 262144));
      throw new Error("simulated connection loss after accepted bytes");
    }
    assert.equal(start, 262144);
    chunks.push(data);
    return Response.json({ id: "uploaded_file_123", name: "large.bin", size: String(bytes.length) });
  };
  const result = await runBridge(["push", "--file", source, "--folder-id", "test_folder_123"],
    { env: { GDRIVE_ACCESS_TOKEN: "test-token" }, fetch });
  assert.equal(probe, true);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  await assert.rejects(runBridge(["push", "--file", source], { env: {}, fetch }), /GDRIVE_ACCESS_TOKEN/u);
  await assert.rejects(runBridge(["push", "--file", source], { env: { GDRIVE_ACCESS_TOKEN: "test-token" }, fetch }), /folder-id/u);
});

test("private Drive pull strips credentials on redirect and publishes only verified bytes", async t => {
  const dir = await directory(t), out = join(dir, "download.bin");
  const bytes = Buffer.from("private Drive binary \u0000\u00ff");
  let calls = 0;
  const fetch = async (input, init) => {
    calls++;
    if (new URL(input).hostname === "www.googleapis.com") {
      assert.equal(init.headers.Authorization, "Bearer test-token");
      return new Response(null, { status: 302, headers: { Location: "https://content.googleusercontent.com/download" } });
    }
    assert.equal(init.headers.Authorization, undefined);
    return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } });
  };
  const result = await runBridge(["pull", "--file-id", "private_file_123", "--out", out],
    { env: { GDRIVE_ACCESS_TOKEN: "test-token" }, fetch });
  assert.equal(calls, 2);
  assert.equal(result.size, bytes.length);
  assert.deepEqual(await readFile(out), bytes);
  await assert.rejects(runBridge(["pull", "--file-id", "private_file_123", "--out", join(dir, "bad.bin"), "--sha256", "0".repeat(64)],
    { env: { GDRIVE_ACCESS_TOKEN: "test-token" }, fetch }), /SHA-256/u);
  assert.deepEqual(await readdir(dir), ["download.bin"]);
});

test("the CLI sends real HTTPS CONNECT through the configured proxy and fails without direct fallback", async t => {
  const dir = await directory(t);
  const targets = [];
  const proxy = createServer();
  proxy.on("connect", (req, socket) => {
    targets.push(req.url);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const url = "http://127.0.0.1:" + proxy.address().port;
  await assert.rejects(runBridge(["pull", "--file-id", "public_file_123", "--out", join(dir, "file.bin"), "--timeout-ms", "1000"],
    { env: { HTTPS_PROXY: url, NO_PROXY: "" } }), /fetch failed/u);
  assert.deepEqual(targets, ["drive.usercontent.google.com:443"]);
  assert.deepEqual(await readdir(dir), []);
});
