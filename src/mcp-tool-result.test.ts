import assert from "node:assert/strict";
import test from "node:test";
import { toolResultBytes, toolResultForTextClients } from "./mcp-tool-result.js";
import { REPLY_BYTES, textPage } from "./bounded-reply.js";

test("首段、末段和合并文本宿主收到同一完整回执，元数据和说明保留", () => {
  const body = { workspace_id: "qm:s1:ws_one", operation_id: "op_one", result: "完成", next_cursor: 9 };
  const metadata = { quaymesh: { private_ui: "card-only" } };
  const original = { content: [{ type: "text", text: "Follow the next cursor." }], structuredContent: body, _meta: metadata };
  const reply = toolResultForTextClients(original);
  assert.equal(reply.content.length, 1);
  const expected = { ...body, _quaymesh_text_notes: [original.content[0]!.text] };
  for (const text of [reply.content[0]!.text, reply.content.at(-1)!.text, reply.content.map(block => block.text).join("\n")])
    assert.deepEqual(JSON.parse(text), expected);
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
  assert.equal(reply.content.length, 3);
  assert.equal(reply.content[0]!.type, "text");
  assert.equal((reply.content[0] as { text: string }).text, JSON.stringify(body));
  assert.equal(reply.content[1], image);
  assert.equal(reply.content[2], resource);
  assert.equal(toolResultBytes(reply), Buffer.byteLength(JSON.stringify(reply)));
});

test("错误解释与恢复信息均可从文本读取", () => {
  const body = { error_code: "REQUEST_TIMEOUT", effect: "unknown", retry_hint: "query_original", operation_id: "op_error" };
  const reply = toolResultForTextClients({ isError: true,
    content: [{ type: "text", text: "The worker result was not received." }], structuredContent: body });
  assert.equal(reply.isError, true);
  assert.equal(reply.content.length, 1);
  assert.deepEqual(JSON.parse(reply.content[0]!.text), { ...body,
    _quaymesh_text_notes: ["The worker result was not received."] });
});

test("说明命名空间碰撞不覆盖业务字段，往返与路由改写不会重复镜像", () => {
  const body = { workspace_id: "ws_one", _quaymesh_text_notes: "business field", _quaymesh_text_notes_2: ["also business"] };
  const first = toolResultForTextClients({ content: [
    { type: "text", text: "Use operation_id to recover." }, { type: "text", text: "Use operation_id to recover." },
  ], structuredContent: body });
  assert.equal(first.content.length, 1);
  const expected = { ...body, _quaymesh_text_notes_3: ["Use operation_id to recover."] };
  assert.deepEqual(JSON.parse(first.content[0]!.text), expected);
  assert.deepEqual(toolResultForTextClients(JSON.parse(JSON.stringify(first))), first);
  const withoutBlockMeta = { ...first, content: [{ type: "text", text: first.content[0]!.text }] };
  assert.deepEqual(toolResultForTextClients(withoutBlockMeta), first);
  const routed = toolResultForTextClients({ ...first, structuredContent: { ...body, workspace_id: "qm:s1:ws_one" } });
  assert.deepEqual(JSON.parse(routed.content[0]!.text), { ...expected, workspace_id: "qm:s1:ws_one" });
  assert.deepEqual(routed.structuredContent, { ...body, workspace_id: "qm:s1:ws_one" });
  assert.equal(toolResultBytes(routed), Buffer.byteLength(JSON.stringify(routed)));
  const appended = `${first.content[0]!.text}\nAdditional recovery evidence.`;
  const altered = toolResultForTextClients({ ...first, content: [{ ...first.content[0]!, text: appended }] });
  assert.deepEqual(JSON.parse(altered.content[0]!.text)._quaymesh_text_notes_3, [appended],
    "a modified or malformed marked block must not silently lose its explanation");
});

test("零值、数组和纯文本结果保留各自语义", () => {
  for (const structuredContent of [null, false, 0, "", ["a", "b"]]) {
    const reply = toolResultForTextClients({ content: [], structuredContent });
    assert.deepEqual(JSON.parse((reply.content[0] as { text: string }).text), structuredContent);
    const described = toolResultForTextClients({ content: [{ type: "text", text: "Explanation." }], structuredContent });
    assert.deepEqual(JSON.parse(described.content[0]!.text), { structuredContent, _quaymesh_text_notes: ["Explanation."] });
    assert.deepEqual(toolResultForTextClients(described), described);
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
