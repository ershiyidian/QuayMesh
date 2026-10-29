import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { withLocallyAuthenticatedTaskClient, retainLocalTaskClient } from "./tasks/task-binding.js";
import {
  conversationScopeIdFromRequestMeta,
  safeForwardedContext,
  sessionRequestIdentity,
  widgetInstanceIdFromResultMeta,
} from "./request-meta.js";

test("conversation scope resolves valid OpenAI session metadata", () => {
  for (const meta of [
    undefined,
    {},
    { "openai/session": "" },
    { "openai/session": 42 },
    { "openai/session": {} },
  ]) {
    assert.equal(conversationScopeIdFromRequestMeta(meta), undefined);
  }

  assert.equal(
    conversationScopeIdFromRequestMeta({
      "openai/session": "chat-session-opaque-value",
      "openai/subject": "user-1",
      "openai/organization": "org-1",
    }),
    "chat-session-opaque-value",
  );
});

test("session request identity uses authenticated owner and server transport identity", () => {
  const identity = sessionRequestIdentity({
    authInfo: {
      clientId: "oauth-client",
      extra: {
        owner_id: "local-owner",
        transport_instance_id: "authenticated-transport",
        authorization: "Bearer secret",
      },
    },
    sessionId: "server-session",
    requestId: 17,
    _meta: {
      "openai/session": "conversation-1",
      cookie: "session=secret",
    },
  });

  const { task_entry: entry, ...transportIdentity } = identity;
  assert.deepEqual(transportIdentity, {
    owner_id: "local-owner",
    conversation_id: "conversation-1",
    transport_instance_id: "server-session",
    request_id: 17,
  });
  assert.ok(entry);
  assert.equal(entry.principal.ownerId, "local-owner");
  assert.equal(entry.clientId, "oauth-client");
  assert.equal(entry.key, createHash("sha256").update("conversation-1").digest("hex"));
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(JSON.stringify(identity).includes("secret"), false);
  assert.throws(
    () => sessionRequestIdentity({ requestId: 1, sessionId: "transport" }),
    /MISSING_AUTHENTICATED_OWNER/,
  );
  assert.throws(
    () => sessionRequestIdentity({
      authInfo: { extra: { owner_id: "local-owner" } },
      requestId: 1,
    }),
    /MISSING_TRANSPORT_INSTANCE/,
  );
  assert.throws(
    () => sessionRequestIdentity({
      authInfo: { extra: { owner_id: "local-owner" } },
      sessionId: "transport",
    }),
    /MISSING_REQUEST_ID/,
  );
});

test("Task execution entry follows verified owner/client and host correlation rather than transport or untrusted metadata", () => {
  const authInfo = { clientId: "oauth-client", extra: { owner_id: "verified-owner" } };
  const first = sessionRequestIdentity({ authInfo, sessionId: "transport-a", requestId: 1,
    _meta: { "openai/session": "entry", owner_id: "untrusted-owner", task_id: "untrusted-task",
      task_entry: { principal: { ownerId: "untrusted-owner" }, clientId: "untrusted-client" } } });
  const second = sessionRequestIdentity({ authInfo, sessionId: "transport-b", requestId: 2,
    _meta: { "openai/session": "entry" } });
  assert.equal(first.owner_id, "verified-owner");
  assert.equal(first.task_id, undefined, "host metadata cannot impersonate an internally captured Task");
  assert.equal(first.task_entry?.principal.ownerId, "verified-owner");
  assert.equal(first.task_entry?.clientId, "oauth-client");
  assert.equal(first.task_entry?.key, second.task_entry?.key, "reconnecting the MCP transport preserves the entry correlation");
  const changed = sessionRequestIdentity({ authInfo, sessionId: "transport-b", requestId: 3,
    _meta: { "openai/session": "replacement-entry" } });
  assert.notEqual(changed.task_entry?.key, first.task_entry?.key);
  const legacy = sessionRequestIdentity({ authInfo, sessionId: "transport", requestId: 4 });
  assert.equal(legacy.task_entry, undefined, "missing correlation is not replaced with a transport or client ID");
  const forwarded = sessionRequestIdentity({ authInfo, requestId: 5,
    trustedInvocation: { owner_id: "verified-owner", transport_instance_id: "original-transport", request_id: "original-request",
      task_id: "captured-task", invocation_id: "captured-invocation", conversation_id: "entry" } });
  assert.equal(forwarded.task_id, "captured-task");
  assert.equal(forwarded.invocation_id, "captured-invocation");
  assert.equal(forwarded.transport_instance_id, "original-transport");
  assert.equal(forwarded.request_id, "original-request");
  assert.equal(forwarded.task_entry?.key, first.task_entry?.key);
});

test("widget identity comes only from widget result metadata", () => {
  assert.equal(widgetInstanceIdFromResultMeta(undefined), undefined);
  assert.equal(widgetInstanceIdFromResultMeta({ "openai/widgetSessionId": 12 }), undefined);
  assert.equal(
    widgetInstanceIdFromResultMeta({
      "openai/widgetSessionId": "widget-view-1",
      "openai/session": "conversation-1",
    }),
    "widget-view-1",
  );
});

test("显式 Task 只限定调用身份，不能覆盖已捕获的远端 Task", () => {
  const identity = {authInfo: {clientId: "client", extra: {owner_id: "owner"}}, sessionId: "transport", requestId: 1};
  const selected = sessionRequestIdentity({...identity, requestedTaskId: "task-selected"});
  assert.equal(selected.task_id, "task-selected");
  assert.equal(selected.task_entry, undefined);
  assert.equal(selected.task_creation, undefined);
  assert.throws(() => sessionRequestIdentity({...identity, requestedTaskId: "other-task",
    trustedInvocation: {task_id: "captured-task"}}), /TASK_SCOPE_MISMATCH/);
});

test("本机认证创建身份不能经 JSON 或另一个 clientId 继承", () => {
  const authInfo = withLocallyAuthenticatedTaskClient({clientId: "client", extra: {owner_id: "owner"}});
  const identity = {authInfo, sessionId: "transport", requestId: 1};
  assert.equal(sessionRequestIdentity(identity).task_creation?.clientId, "client");
  assert.equal(sessionRequestIdentity({...identity, authInfo: JSON.parse(JSON.stringify(authInfo))}).task_creation, undefined);
  assert.equal(sessionRequestIdentity({...identity, authInfo: retainLocalTaskClient(authInfo,
    {clientId: "client", extra: {owner_id: "owner"}})}).task_creation?.principal.ownerId, "owner");
  assert.equal(sessionRequestIdentity({...identity, authInfo: retainLocalTaskClient(authInfo,
    {clientId: "other-client", extra: {owner_id: "owner"}})}).task_creation, undefined);
  assert.equal(sessionRequestIdentity({...identity, authInfo: retainLocalTaskClient(authInfo,
    {clientId: "client", extra: {owner_id: "other-owner"}})}).task_creation, undefined);
});

test("safe forwarded context keeps correlation fields and strips secrets", () => {
  const forwarded = safeForwardedContext({
    authInfo: {
      clientId: "oauth-client",
      extra: {
        owner_id: "local-owner",
        access_token: "secret-token",
        authorization: "Bearer secret-token",
        cookie: "session=secret",
        env: { TOKEN: "secret" },
        callback: () => undefined,
      },
    },
    sessionId: "server-session",
    requestId: "request-1",
    _meta: {
      "openai/session": "conversation-1",
      "openai/subject": "subject-1",
      authorization: "Bearer secret-token",
    },
    requestInfo: {
      headers: {
        "mcp-session-id": "transport-1",
        authorization: "Bearer secret-token",
        cookie: "session=secret",
        "x-api-key": "secret-key",
        "user-agent": "host",
      },
    },
  });

  assert.deepEqual(forwarded, {
    client_id: "oauth-client",
    owner_id: "local-owner",
    transport_session_id: "server-session",
    transport_instance_id: "transport-1",
    request_id: "request-1",
    conversation_id: "conversation-1",
  });
  assert.equal(JSON.stringify(forwarded).includes("secret"), false);
  assert.equal("authorization" in forwarded, false);
  assert.equal("cookie" in forwarded, false);
  assert.equal("env" in forwarded, false);
  assert.equal("callback" in forwarded, false);
});
