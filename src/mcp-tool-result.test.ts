import assert from "node:assert/strict";
import test from "node:test";
import { toolResultBytes, toolResultForTextClients } from "./mcp-tool-result.js";
import { REPLY_BYTES, textPage } from "./bounded-reply.js";

test("文本客户端收到完整回执，原元数据和独有说明保持不变", () => {
  const body = { workspace_id: "qm:s1:ws_one", operation_id: "op_one", result: "完成", next_cursor: 9 };
  const metadata = { quaymesh: { private_ui: "card-only" } };
  const original = { content: [{ type: "text", text: "Follow the next cursor." }], structuredContent: body, _meta: metadata };
  const reply = toolResultForTextClients(original);
  assert.deepEqual(JSON.parse(reply.content[0]!.text), body);
  assert.equal(reply.content[1]!.text, original.content[0]!.text);
  assert.equal(reply.structuredContent, body);
  assert.equal(reply._meta, metadata);
  assert.doesNotMatch(reply.content.map(block => block.text).join(""), /card-only/u);
  assert.deepEqual(toolResultForTextClients(reply), reply);
  assert.equal(original.content.length, 1);
});

test("长正文与已有 JSON 只镜像一次，媒体块原样保留", () => {
  const body = { result: '中文😀 "\\'.repeat(1000), operation_id: "op_large" };
  const image = { type: "image", data: "AA==", mimeType: "image/png" };
  const resource = { type: "resource_link", uri: "file:///result.txt", name: "result" };
  const reply = toolResultForTextClients({ content: [
    { type: "text", text: body.result }, { type: "text", text: JSON.stringify(body, null, 2) }, image, resource,
  ], structuredContent: body });
  assert.deepEqual(reply.content, [{ type: "text", text: JSON.stringify(body) }, image, resource]);
  assert.equal(reply.content[1], image);
  assert.equal(reply.content[2], resource);
  assert.equal(toolResultBytes(reply), Buffer.byteLength(JSON.stringify(reply)));
});

test("错误解释与恢复信息均可从文本读取", () => {
  const body = { error_code: "REQUEST_TIMEOUT", effect: "unknown", retry_hint: "query_original", operation_id: "op_error" };
  const reply = toolResultForTextClients({ isError: true,
    content: [{ type: "text", text: "The worker result was not received." }], structuredContent: body });
  assert.equal(reply.isError, true);
  assert.equal(reply.content[1]!.text, "The worker result was not received.");
  assert.deepEqual(JSON.parse(reply.content[0]!.text), body);
});

test("零值、数组和纯文本结果保留各自语义", () => {
  for (const structuredContent of [null, false, 0, "", ["a", "b"]]) {
    const reply = toolResultForTextClients({ content: [], structuredContent });
    assert.deepEqual(JSON.parse((reply.content[0] as { text: string }).text), structuredContent);
  }
  const plain = { content: [{ type: "text", text: "plain" }] };
  assert.equal(toolResultForTextClients(plain), plain);
});

test("页面按完整镜像回包分页，转义文本和 Unicode 游标保持完整", () => {
  const source = '中文😀 "\\\n'.repeat(12000);
  let offset = 0;
  const pieces: string[] = [];
  while (true) {
    const reply = (text: string, next: number | null) => ({ content: [{ type: "text", text: "Read file." }],
      structuredContent: { result: text, response_page: { offset, next_offset: next } } });
    const page = textPage(source, offset, REPLY_BYTES, value => toolResultBytes(reply(value.text, value.nextOffset)));
    const result = toolResultForTextClients(reply(page.text, page.nextOffset));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= REPLY_BYTES);
    assert.equal(JSON.parse(result.content[0]!.text).result, page.text);
    pieces.push(page.text);
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.equal(pieces.join(""), source);
});
