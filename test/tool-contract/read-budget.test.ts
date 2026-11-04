import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { REPLY_BYTES } from "../../src/bounded-reply.js";
import { createInlineBase64ArtifactAdapter } from "../../src/incoming-artifacts.js";
import { readFileTool } from "../../src/pi-tools.js";
import { fixture } from "./fixture.js";

for (const sample of [
  {
    name: "read paginates escaped UTF-8 text without losing code points",
    text: '中文😀 "quote" \\path\tvalue\n'.repeat(1350),
    truncated: false,
  },
  {
    name: "read keeps Pi truncation details out of its bounded MCP reply",
    text: '中文😀 "quote" \\path\tvalue\n'.repeat(5000),
    truncated: true,
  },
]) {
  test(sample.name, async (t) => {
    const f = await fixture(t, { git: false });
    const path = "paged-utf8.txt";
    const absolutePath = join(f.project, path);
    await writeFile(absolutePath, sample.text, "utf8");

    const source = await readFileTool({ path: absolutePath, offset: 1, limit: 10000 }, { cwd: f.project });
    assert.notEqual(source.isError, true);
    const expected = source.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    const details = source.details as { truncation?: { truncated?: boolean; content?: string } } | undefined;
    if (sample.truncated) {
      assert.ok(details?.truncation);
      assert.equal(details.truncation.truncated, true);
      assert.equal(typeof details.truncation.content, "string");
      assert.ok(Buffer.byteLength(JSON.stringify(source.details), "utf8") > 4096);
    } else {
      assert.equal(expected, sample.text);
    }

    const parts: string[] = [];
    let offset = 0;
    let pages = 0;
    while (true) {
      const reply = await f.raw("read", { ...f.scope, path, offset: 1, limit: 10000, response_offset: offset });
      assert.notEqual(reply.isError, true, JSON.stringify(reply));
      assert.ok(Buffer.byteLength(JSON.stringify(reply), "utf8") <= REPLY_BYTES);
      assert.equal(Object.hasOwn(reply, "details"), false);
      assert.ok(Array.isArray(reply.content));
      const textBody = reply.content.find(block => block.type === "text" && block.text.startsWith('{"result":'));
      assert.ok(textBody && textBody.type === "text");
      const body = reply.structuredContent as {
        result: string;
        result_sha256: string;
        response_page: { offset: number; next_offset: number | null; total_code_points: number };
      };
      assert.equal(reply.content.filter(block => block.type === "text").length, 1);
      const { _quaymesh_text_notes: notes, ...textPayload } = JSON.parse(textBody.text);
      assert.deepEqual(textPayload, body);
      assert.deepEqual(notes, [`已读取 ${path}，正文见 result。`]);
      assert.equal(body.result_sha256, createHash("sha256").update(expected).digest("hex"));
      assert.equal(body.response_page.offset, offset);
      assert.equal(body.response_page.total_code_points, Array.from(expected).length);
      parts.push(body.result);
      pages++;
      const next = body.response_page.next_offset;
      if (next === null) break;
      assert.equal(next, offset + Array.from(body.result).length);
      assert.ok(next > offset);
      assert.ok(pages < 20, "pagination must make bounded progress");
      offset = next;
    }
    assert.ok(pages > 1);
    assert.equal(parts.join(""), expected);
  });
}

test("read encoding=base64 paginates binary files within REPLY_BYTES budget and restores exact bytes", async (t) => {
  const f = await fixture(t, {
    git: false,
    incomingArtifactAdapters: [createInlineBase64ArtifactAdapter()],
    configure: async (config) => ({ ...config, artifactsEnabled: true }),
  });
  const path = "binary-sample.bin";
  const rawBytes = Buffer.alloc(60_000);
  for (let i = 0; i < rawBytes.length; i++) {
    rawBytes[i] = (i * 73 + 19) & 0xff;
  }
  const expectedSha256 = createHash("sha256").update(rawBytes).digest("hex");

  // 通过真实 MCP 入口写入，再按字节分页取回。
  const downloaded = await f.raw("download_artifact", {
    ...f.scope,
    path,
    file: {
      content_base64: rawBytes.toString("base64"),
      file_name: path,
      mime_type: "application/octet-stream",
      size: rawBytes.length,
      sha256: expectedSha256,
    },
  });
  assert.notEqual(downloaded.isError, true, JSON.stringify(downloaded));
  assert.deepEqual(downloaded.structuredContent, { path });

  const chunks: Buffer[] = [];
  let offset = 0;
  let pages = 0;
  while (true) {
    const reply = await f.raw("read", {
      ...f.scope,
      path,
      encoding: "base64",
      response_offset: offset,
      limit: 16_384,
    });
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    assert.ok(Buffer.byteLength(JSON.stringify(reply), "utf8") <= REPLY_BYTES);
    const body = reply.structuredContent as {
      result: string;
      result_sha256: string;
      response_page: { offset: number; next_offset: number | null; total_code_points: number };
    };
    const chunk = Buffer.from(body.result, "base64");
    assert.equal(body.result_sha256, createHash("sha256").update(chunk).digest("hex"));
    assert.equal(body.response_page.offset, offset);
    assert.equal(body.response_page.total_code_points, rawBytes.length);
    chunks.push(chunk);
    pages++;
    if (body.response_page.next_offset === null) break;
    offset = body.response_page.next_offset;
  }
  assert.equal(pages, 4);
  assert.deepEqual(Buffer.concat(chunks), rawBytes);

  for (const limit of [1, 2]) {
    const reply = await f.raw("read", { ...f.scope, path, encoding: "base64", response_offset: 7, limit });
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    const body = reply.structuredContent as { result: string; response_page: { next_offset: number } };
    assert.deepEqual(Buffer.from(body.result, "base64"), rawBytes.subarray(7, 7 + limit));
    assert.equal(body.response_page.next_offset, 7 + limit);
  }

  const maxInline = Buffer.alloc(1024 * 1024, 0xa5);
  const maxReply = await f.raw("download_artifact", {
    ...f.scope, path: "inline-limit.bin",
    file: { content_base64: maxInline.toString("base64"), size: maxInline.length },
  });
  assert.notEqual(maxReply.isError, true, JSON.stringify(maxReply));
  assert.deepEqual(await readFile(join(f.project, "inline-limit.bin")), maxInline);
});
