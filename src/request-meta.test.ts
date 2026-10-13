import assert from "node:assert/strict";
import test from "node:test";
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

  assert.deepEqual(identity, {
    owner_id: "local-owner",
    conversation_id: "conversation-1",
    transport_instance_id: "server-session",
    request_id: 17,
  });
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
