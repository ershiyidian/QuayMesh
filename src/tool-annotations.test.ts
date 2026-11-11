import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandler, type ListToolsResult } from "@modelcontextprotocol/server";
import { createModernMcpServerAdapter } from "./mcp-modern-server.js";
import { readToolAnnotations, writeToolAnnotations } from "./tool-annotations.js";

test("统一配置更新后，运行中的无状态 MCP 服务立即返回新标识", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qm-tool-annotations-"));
  t.after(() => rm(stateDir, {recursive:true,force:true}));
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter(
      {name:"annotations-test",version:"1.0.0"},
      undefined,
      readToolAnnotations(stateDir),
    );
    adapter.registrationTarget.registerTool("open_workspace", {
      inputSchema: {},
      annotations: {readOnlyHint:false,destructiveHint:true,openWorldHint:true},
    }, async() => ({content:[{type:"text",text:"ok"}]}));
    return adapter.server;
  }, {legacy:"reject"});
  t.after(async()=>handler.close());
  const listed = async () => {
    const response = await handler.fetch(new Request("https://example.test/mcp", {
      method:"POST",
      headers:{"content-type":"application/json","mcp-method":"tools/list","mcp-protocol-version":"2026-07-28"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{
        _meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
          "io.modelcontextprotocol/clientCapabilities":{}},
      }}),
    }));
    assert.equal(response.status,200,await response.clone().text());
    const result = await response.json() as {result:ListToolsResult};
    return result.result.tools.find(tool=>tool.name==="open_workspace")?.annotations;
  };
  assert.equal((await listed())?.readOnlyHint,false);
  await writeToolAnnotations(stateDir,{open_workspace:{
    readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true,
  }});
  const changed = await listed();
  assert.equal(changed?.readOnlyHint,true);
  assert.equal(changed?.destructiveHint,false);
  assert.equal(changed?.openWorldHint,false);
  assert.equal(changed?.idempotentHint,true);
  await writeToolAnnotations(stateDir,{open_workspace:{
    readOnlyHint:false,destructiveHint:true,openWorldHint:true,
  }});
  assert.equal((await listed())?.readOnlyHint,false);
});
