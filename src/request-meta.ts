function metadataString(
  meta: unknown,
  key: string,
): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) {
    return value[0];
  }
  return undefined;
}

export function conversationScopeIdFromRequestMeta(
  meta: unknown,
): string | undefined {
  return metadataString(meta, "openai/session");
}

export interface SessionRequestIdentity {
  owner_id: string;
  conversation_id: string | null;
  transport_instance_id: string;
  request_id: string | number;
  invocation_id?: string;
  task_id?: string;
}

export interface SessionRequestIdentityInput {
  authInfo?: {
    clientId?: string;
    extra?: Record<string, unknown>;
  };
  sessionId?: string;
  requestId?: string | number;
  _meta?: unknown;
  trustedInvocation?: {
    invocation_id?: string;
    task_id?: string;
    owner_id?: string;
    conversation_id?: string | null;
    transport_instance_id?: string;
    request_id?: string | number;
  };
  requestInfo?: {
    headers?: unknown;
  };
}

export function sessionRequestIdentity(
  input: SessionRequestIdentityInput,
): SessionRequestIdentity {
  const authInfo = input.authInfo;
  if (!authInfo) throw new Error("MISSING_AUTHENTICATED_OWNER");
  const ownerId = authInfo.extra?.owner_id ?? input.trustedInvocation?.owner_id;
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    throw new Error("MISSING_AUTHENTICATED_OWNER");
  }

  const transportInstanceId = firstNonEmpty(
    input.trustedInvocation?.transport_instance_id,
    input.sessionId,
    headerValue(input.requestInfo?.headers, "mcp-session-id"),
    typeof authInfo.extra?.transport_instance_id === "string"
      ? authInfo.extra.transport_instance_id
      : undefined,
    authInfo.clientId,
  );
  if (!transportInstanceId) throw new Error("MISSING_TRANSPORT_INSTANCE");

  const requestId = input.trustedInvocation?.request_id ?? input.requestId;
  if (requestId === undefined || requestId === null || requestId === "") {
    throw new Error("MISSING_REQUEST_ID");
  }

  return {
    owner_id: ownerId,
    conversation_id: conversationScopeIdFromRequestMeta(input._meta) ?? input.trustedInvocation?.conversation_id ?? null,
    transport_instance_id: transportInstanceId,
    request_id: requestId,
    ...(input.trustedInvocation?.invocation_id ? { invocation_id: input.trustedInvocation.invocation_id } : {}),
    ...(input.trustedInvocation?.task_id ? { task_id: input.trustedInvocation.task_id } : {}),
  };
}

export function widgetInstanceIdFromResultMeta(meta: unknown): string | undefined {
  return metadataString(meta, "openai/widgetSessionId");
}

export function safeForwardedContext(extra: {
  authInfo?: SessionRequestIdentityInput["authInfo"];
  sessionId?: string;
  requestId?: string | number;
  _meta?: unknown;
  requestInfo?: { headers?: unknown };
}): Record<string, unknown> {
  const headers = extra.requestInfo?.headers;
  const conversationScope = conversationScopeIdFromRequestMeta(extra._meta);
  return {
    ...(extra.authInfo?.clientId ? { client_id: extra.authInfo.clientId } : {}),
    ...(typeof extra.authInfo?.extra?.owner_id === "string"
      ? { owner_id: extra.authInfo.extra.owner_id }
      : {}),
    ...(extra.sessionId ? { transport_session_id: extra.sessionId } : {}),
    ...(headerValue(headers, "mcp-session-id") ?? extra.authInfo?.extra?.transport_instance_id
      ? { transport_instance_id: headerValue(headers, "mcp-session-id") ?? extra.authInfo?.extra?.transport_instance_id }
      : {}),
    ...(extra.requestId !== undefined ? { request_id: extra.requestId } : {}),
    ...(conversationScope ? { conversation_id: conversationScope } : {}),
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}
