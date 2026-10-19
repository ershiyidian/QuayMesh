import assert from "node:assert/strict";
import test from "node:test";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { createMcpHandler, McpServer, type CallToolResult, type ListToolsResult } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import * as z from "zod/v4";
import {
  compileMcpRegistrationSurface,
  createModernMcpServerAdapter,
  modernMcpAdapterErrorLogFields,
} from "./mcp-modern-server.js";
import { toolErrorResult } from "./session/outcome.js";

test("strict modern handler answers the 2026-07-28 discovery probe", async (t) => {
  const handler = createMcpHandler(() => new McpServer(
    { name: "quaymesh-modern-test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  ), { legacy: "reject" });
  t.after(async () => handler.close());

  const response = await handler.fetch(modernRequest("server/discover", {}));

  assert.equal(response.status, 200);
  const body = await response.json() as {
    result?: { supportedVersions?: string[] };
  };
  assert.ok(body.result?.supportedVersions?.includes("2026-07-28"));
});

test("modern registration adapter preserves tools and request metadata", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "quaymesh-modern-test",
      version: "1.0.0",
    });
    registerAppTool(
      adapter.registrationTarget,
      "echo_scope",
      {
        description: "Echo the modern request scope.",
        inputSchema: { value: z.string() },
        _meta: {},
      },
      async ({ value }, { _meta }) => ({
        content: [{
          type: "text",
          text: `${value}:${String(_meta?.["openai/session"] ?? "missing")}`,
        }],
      }),
    );
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const listed = await handler.fetch(modernRequest("tools/list", {}));
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as {
    result?: { tools?: Array<{ name?: string }> };
  };
  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "echo_scope"));

  const called = await handler.fetch(modernRequest("tools/call", {
    name: "echo_scope",
    arguments: { value: "ok" },
    _meta: { "openai/session": "modern-chat" },
  }));
  assert.equal(called.status, 200, await called.clone().text());
  const callBody = await called.json() as {
    result?: { content?: Array<{ text?: string }> };
  };
  assert.equal(callBody.result?.content?.[0]?.text, "ok:modern-chat");
});

test("输出 schema 兼容业务错误，同时保留成功结果的运行时校验", async (t) => {
  const failure = toolErrorResult(new Error("REQUEST_TIMEOUT: operation receipt unavailable"), {
    operationId: "op-output-schema-test",
    ownerNodeId: "node-output-schema-test",
  });
  const success = { content: [], structuredContent: { value: "ok" } };
  const cases = {
    success,
    proper_error: failure,
    misflagged_error: { ...failure, isError: false },
    unflagged_error: { content: failure.content, structuredContent: failure.structuredContent },
    invalid_success: { content: [], structuredContent: { value: 42 } },
  };
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({ name: "output-schema-test", version: "1.0.0" });
    for (const [name, result] of Object.entries(cases)) {
      registerRawTool(adapter.registrationTarget, name, {
        inputSchema: {},
        outputSchema: z.strictObject({ value: z.string() }),
      }, async () => result);
    }
    registerRawTool(adapter.registrationTarget, "raw_shape", {
      inputSchema: {},
      outputSchema: { value: z.string() },
    }, async () => success);
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const listed = await handler.fetch(modernRequest("tools/list", {}));
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as { result: ListToolsResult };
  for (const name of ["success", "raw_shape"]) {
    const output = listBody.result.tools.find((tool) => tool.name === name)?.outputSchema;
    assert.ok(output);
    assert.equal(output.type, "object");
    const validate = new AjvJsonSchemaValidator().getValidator(output);
    assert.equal(validate(success.structuredContent).valid, true);
    assert.equal(validate(failure.structuredContent).valid, true);
    assert.equal(validate({ value: 42 }).valid, false);
    assert.equal(validate({ ...failure.structuredContent, retry_hint: "unknown" }).valid, false);
  }

  for (const name of ["proper_error", "success", "raw_shape"]) {
    const response = await handler.fetch(modernRequest("tools/call", { name, arguments: {} }));
    assert.equal(response.status, 200);
    const body = await response.json() as { result: CallToolResult };
    const expected = name === "proper_error" ? failure : success;
    assert.deepEqual(body.result.content, expected.content);
    assert.deepEqual(body.result.structuredContent, expected.structuredContent);
    assert.equal(body.result.isError === true, name === "proper_error");
  }
  for (const name of ["misflagged_error", "unflagged_error", "invalid_success"]) {
    const response = await handler.fetch(modernRequest("tools/call", { name, arguments: {} }));
    assert.equal(response.status, 200);
    const body = await response.json() as { result: CallToolResult };
    assert.equal(body.result.isError, true, name);
    assert.equal(body.result.structuredContent, undefined, name);
    assert.match(JSON.stringify(body.result.content), /Output validation error/, name);
  }
});

test("输出 schema 的递归成功类型不会接受嵌套错误回执", async (t) => {
  interface TreeValue { value: string; child?: TreeValue }
  const tree: z.ZodType<TreeValue> = z.strictObject({
    value: z.string(),
    child: z.lazy(() => tree).optional(),
  });
  const failure = toolErrorResult(new Error("REQUEST_TIMEOUT"));
  const valid = { value: "root", child: { value: "leaf" } };
  const nestedError = { value: "root", child: failure.structuredContent };
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({ name: "recursive-output-test", version: "1.0.0" });
    registerRawTool(adapter.registrationTarget, "tree", {
      inputSchema: { nested_error: z.boolean() },
      outputSchema: tree,
    }, async (input) => ({
      content: [],
      structuredContent: objectValue(input).nested_error ? nestedError : valid,
    }));
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const listed = await handler.fetch(modernRequest("tools/list", {}));
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as { result: ListToolsResult };
  const output = listBody.result.tools.find((tool) => tool.name === "tree")?.outputSchema;
  assert.ok(output);
  const validate = new AjvJsonSchemaValidator().getValidator(output);
  assert.equal(validate(valid).valid, true);
  assert.equal(validate(failure.structuredContent).valid, true);
  assert.equal(validate(nestedError).valid, false);
  assert.equal(validate({ value: "root", unexpected: true }).valid, false);

  for (const nested_error of [false, true]) {
    const response = await handler.fetch(modernRequest("tools/call", {
      name: "tree", arguments: { nested_error },
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as { result: CallToolResult };
    if (nested_error) {
      assert.equal(body.result.isError, true);
      assert.match(JSON.stringify(body.result.content), /Output validation error/);
    } else {
      assert.deepEqual(body.result.structuredContent, valid);
    }
  }
});

test("modern registration adapter preserves progress notifications", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "quaymesh-modern-test",
      version: "1.0.0",
    });
    registerAppTool(
      adapter.registrationTarget,
      "progress_echo",
      {
        inputSchema: {},
        _meta: {},
      },
      async (_input, { sendNotification }) => {
        await sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: "modern-progress",
            progress: 1,
            total: 1,
          },
        });
        return { content: [{ type: "text", text: "done" }] };
      },
    );
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const response = await handler.fetch(modernRequest("tools/call", {
    name: "progress_echo",
    arguments: {},
    _meta: { progressToken: "modern-progress" },
  }));

  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const messages = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  assert.ok(messages.some((message) => message.method === "notifications/progress"));
  assert.match(JSON.stringify(messages.at(-1)), /done/);
});

test("modern registration adapter preserves resources", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "quaymesh-modern-test",
      version: "1.0.0",
    });
    registerAppResource(
      adapter.registrationTarget,
      "Test resource",
      "ui://quaymesh/test.html",
      {},
      async (_uri, { _meta }) => ({
        contents: [{
          uri: "ui://quaymesh/test.html",
          mimeType: "text/html",
          text: `resource-ok:${String(_meta?.["openai/session"] ?? "missing")}`,
        }],
      }),
    );
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const response = await handler.fetch(modernRequest("resources/read", {
    uri: "ui://quaymesh/test.html",
    _meta: { "openai/session": "resource-chat" },
  }));

  assert.equal(response.status, 200, await response.clone().text());
  assert.match(await response.text(), /resource-ok:resource-chat/);
});

test("compiled registration surface reuses static tool and resource definitions", async (t) => {
  let registrationBuilds = 0;
  const bindRegistrationSurface = compileMcpRegistrationSurface((target) => {
    registrationBuilds += 1;
    registerAppTool(
      target,
      "cached_echo",
      {
        inputSchema: { value: z.string() },
        _meta: {},
      },
      async ({ value }) => ({
        content: [{ type: "text", text: value }],
      }),
    );
    registerAppResource(
      target,
      "Cached resource",
      "ui://quaymesh/cached.html",
      {},
      async () => ({
        contents: [{
          uri: "ui://quaymesh/cached.html",
          mimeType: "text/html",
          text: "cached-resource",
        }],
      }),
    );
  });
  assert.equal(registrationBuilds, 1);

  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "quaymesh-modern-test",
      version: "1.0.0",
    });
    bindRegistrationSurface(adapter.registrationTarget);
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const firstList = await handler.fetch(modernRequest("tools/list", {}));
  const secondList = await handler.fetch(modernRequest("tools/list", {}));
  assert.equal(firstList.status, 200, await firstList.clone().text());
  assert.equal(secondList.status, 200, await secondList.clone().text());
  assert.equal(registrationBuilds, 1);

  const resource = await handler.fetch(modernRequest("resources/read", {
    uri: "ui://quaymesh/cached.html",
  }));
  assert.equal(resource.status, 200, await resource.clone().text());
  assert.match(await resource.text(), /cached-resource/);
  assert.equal(registrationBuilds, 1);
});

test("compiled registration surface rejects duplicate tools and resources", () => {
  assert.throws(
    () => compileMcpRegistrationSurface((target) => {
      registerRawTool(target, "duplicate_tool", { inputSchema: {} }, async () => ({ content: [] }));
      registerRawTool(target, "duplicate_tool", { inputSchema: {} }, async () => ({ content: [] }));
    }),
    /DUPLICATE_TOOL_REGISTRATION: duplicate_tool/,
  );

  assert.throws(
    () => compileMcpRegistrationSurface((target) => {
      registerRawResource(target, "ui://quaymesh/duplicate.html");
      registerRawResource(target, "ui://quaymesh/duplicate.html");
    }),
    /DUPLICATE_RESOURCE_REGISTRATION: ui:\/\/quaymesh\/duplicate\.html/,
  );
});

test("compiled registration surface requires handlers and output schemas for app-only tools", () => {
  assert.throws(
    () => compileMcpRegistrationSurface((target) => {
      registerRawTool(target, "app_without_handler", {
        inputSchema: {},
        outputSchema: z.object({ ok: z.boolean() }),
        _meta: { ui: { visibility: ["app"] } },
      });
    }),
    /APP_TOOL_HANDLER_REQUIRED: app_without_handler/,
  );

  assert.throws(
    () => compileMcpRegistrationSurface((target) => {
      registerRawTool(target, "app_without_output", {
        inputSchema: {},
        _meta: { ui: { visibility: ["app"] } },
      }, async () => ({ content: [] }));
    }),
    /APP_TOOL_OUTPUT_SCHEMA_REQUIRED: app_without_output/,
  );
});

function registerRawTool(
  target: Parameters<Parameters<typeof compileMcpRegistrationSurface>[0]>[0],
  name: string,
  definition: Record<string, unknown>,
  handler?: (...args: unknown[]) => unknown,
): void {
  const args = handler === undefined ? [name, definition] : [name, definition, handler];
  (target.registerTool as unknown as (...values: unknown[]) => unknown)(...args);
}

function registerRawResource(
  target: Parameters<Parameters<typeof compileMcpRegistrationSurface>[0]>[0],
  uri: string,
): void {
  (target.registerResource as unknown as (...values: unknown[]) => unknown)(uri, uri, {}, async () => ({ contents: [] }));
}

test("modern adapter error logging preserves error and cause identity", () => {
  const fields = modernMcpAdapterErrorLogFields(
    new Error("outer failure", { cause: new TypeError("inner failure") }),
  );
  assert.deepEqual(fields, {
    error: "outer failure",
    errorName: "Error",
    cause: {
      name: "TypeError",
      message: "inner failure",
    },
  });
});

function modernRequest(method: string, params: Record<string, unknown>): Request {
  const mcpName = typeof params.name === "string"
    ? params.name
    : typeof params.uri === "string"
      ? params.uri
      : undefined;
  return new Request("https://example.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(mcpName ? { "mcp-name": mcpName } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `modern-${method}`,
      method,
      params: {
        ...params,
        _meta: {
          ...objectValue(params._meta),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
