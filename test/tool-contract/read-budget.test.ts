import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { REPLY_BYTES } from "../../src/bounded-reply.js";
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
      assert.deepEqual(JSON.parse(textBody.text), body);
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
