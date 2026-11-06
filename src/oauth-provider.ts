import { timingSafeEqual, randomBytes, randomUUID, createHash } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { AccessDeniedError, InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore, usesGooglePersistentLinking, type OAuthDataStore } from "./oauth-store.js";

export interface OAuthConfig {
  resourceAliases?: string[];
  ownerToken: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedResourceUrls: string[];
  allowedRedirectHosts: string[];
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

type OAuthRefreshRejectionReason = "unknown_grant" | "client_mismatch" | "expired_grant"
  | "missing_resource" | "resource_not_allowed" | "resource_mismatch" | "scope_not_allowed"
  | "grant_unavailable";

export type OAuthRefreshDiagnostic = {
  clientId: string;
  refreshPolicy: "google_persistent" | "rotating";
} & ({ outcome: "succeeded"; reason: "renewed" | "renewed_resource_alias" }
  | { outcome: "rejected"; reason: OAuthRefreshRejectionReason });

const CODE_TTL_MS = 5 * 60 * 1000;
export const LOCAL_OWNER_ID = "local-owner";

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formHtml(params: {
  error?: string;
  clientName: string;
  scopes: string[];
  resource?: URL;
  fields: Record<string, string | undefined>;
}): string {
  const scopeText = params.scopes.length > 0 ? params.scopes.join(" ") : "quaymesh";
  const resourceText = params.resource?.href ?? "QuayMesh MCP endpoint";
  const error = params.error
    ? `<p class="error">${htmlEscape(params.error)}</p>`
    : "";
  const hiddenFields = Object.entries(params.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `        <input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect QuayMesh</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
      main { max-width: 440px; margin: 12vh auto; padding: 32px; background: #111827; border: 1px solid #334155; border-radius: 18px; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { line-height: 1.5; color: #cbd5e1; }
      dl { padding: 16px; background: #020617; border-radius: 12px; }
      dt { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
      dd { margin: 4px 0 12px; word-break: break-word; }
      label { display: block; margin: 18px 0 8px; font-weight: 600; }
      input { box-sizing: border-box; width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #475569; background: #020617; color: #e2e8f0; font-size: 16px; }
      button { margin-top: 18px; width: 100%; border: 0; border-radius: 10px; padding: 12px 14px; font-weight: 700; color: #020617; background: #38bdf8; cursor: pointer; }
      .error { color: #fecaca; background: #7f1d1d; border-radius: 10px; padding: 10px 12px; }
      .warning { color: #fde68a; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect QuayMesh</h1>
      <p class="warning">Only approve this if you are intentionally connecting your own ChatGPT or MCP client to this local machine.</p>
      ${error}
      <dl>
        <dt>Client</dt><dd>${htmlEscape(params.clientName)}</dd>
        <dt>Scope</dt><dd>${htmlEscape(scopeText)}</dd>
        <dt>Resource</dt><dd>${htmlEscape(resourceText)}</dd>
      </dl>
      <form method="post">
${hiddenFields}
        <label for="owner_token">Owner password</label>
        <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">Authorize QuayMesh</button>
      </form>
    </main>
  </body>
</html>`;
}

function requestedScopesAllowed(requested: string[], supported: string[]): boolean {
  return requested.every((scope) => supported.includes(scope));
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  acceptsResource(resource: URL): boolean {
    return this.isResourceAllowed(resource);
  }
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly oauthStore: OAuthDataStore;
  private readonly resourceServerUrl: URL;
  private readonly allowedResourceUrls: Set<string>;
  private readonly resourceAliases: Set<string>;

  constructor(
    private readonly config: OAuthConfig,
    resourceServerUrl: URL,
    stateDir: string,
    private readonly reportRefresh?: (diagnostic: OAuthRefreshDiagnostic) => void,
  ) {
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    this.allowedResourceUrls = new Set(
      config.allowedResourceUrls.map((url) => resourceUrlFromServerUrl(url).href),
    );
    this.resourceAliases = new Set((config.resourceAliases ?? []).map((url) => new URL(url).href));
    this.oauthStore = new SqliteOAuthStore(stateDir);
    const clients = new SqliteOAuthClientsStore(this.oauthStore, config.allowedRedirectHosts);
    this.clientsStore = clients;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if ((this.config.resourceAliases?.length ?? 0) > 0 && !params.resource) {
      throw new InvalidRequestError("Invalid or missing OAuth resource");
    }
    if (params.resource && !this.isResourceAllowed(params.resource)) {
      throw new InvalidRequestError("Invalid or missing OAuth resource");
    }
    if (!requestedScopesAllowed(params.scopes ?? [], this.config.scopes)) {
      throw new InvalidRequestError("Requested scope is not supported");
    }
    const effectiveResource = params.resource ?? this.resourceServerUrl;

    if (res.req.method !== "POST") {
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: effectiveResource,
          fields: authorizationFormFields(client, { ...params, resource: effectiveResource }),
        }),
      );
      return;
    }

    const providedToken = String(res.req.body?.owner_token ?? "");
    if (!safeEquals(providedToken, this.config.ownerToken)) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: "The Owner password was not accepted.",
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: effectiveResource,
          fields: authorizationFormFields(client, { ...params, resource: effectiveResource }),
        }),
      );
      return;
    }

    const code = `code-${randomUUID()}`;
    const storedParams: AuthorizationParams = { ...params, resource: effectiveResource };
    const record = { clientId: client.client_id, params: storedParams, expiresAtMs: Date.now() + CODE_TTL_MS };
    this.codes.set(code, record);

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state !== undefined) redirectUrl.searchParams.set("state", params.state);
    res.redirect(302, redirectUrl.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.validCodeRecord(client, authorizationCode);
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.validCodeRecord(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && record.params.resource && !sameResource(resource, record.params.resource, this.resourceAliases)) {
      throw new InvalidGrantError("Invalid resource");
    }
    if (resource && !this.isResourceAllowed(resource)) throw new InvalidGrantError("Invalid resource");

    this.codes.delete(authorizationCode);
    const tokenResource = record.params.resource ?? resource ?? this.resourceServerUrl;
    return this.issueTokens(client.client_id, record.params.scopes ?? this.config.scopes, tokenResource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const persistent = usesGooglePersistentLinking(client);
    const identity = {
      clientId: client.client_id,
      refreshPolicy: persistent ? "google_persistent" as const : "rotating" as const,
    };
    const reject: (reason: OAuthRefreshRejectionReason, error: InvalidGrantError | AccessDeniedError) => never = (reason, error) => {
      this.reportRefresh?.({ ...identity, outcome: "rejected", reason });
      throw error;
    };
    const refreshTokenHash = hashToken(refreshToken);
    const record = this.oauthStore.getRefreshToken(refreshTokenHash);
    if (!record) reject("unknown_grant", new InvalidGrantError("Invalid refresh token"));
    if (record.clientId !== client.client_id) reject("client_mismatch", new InvalidGrantError("Invalid refresh token"));
    if (record.expiresAt < Math.floor(Date.now() / 1000)) reject("expired_grant", new InvalidGrantError("Invalid refresh token"));
    if (!record.resource) reject("missing_resource", new InvalidGrantError("Invalid resource"));
    const recordedResource = new URL(record.resource);
    if (!this.isResourceAllowed(recordedResource)) {
      reject("resource_not_allowed", new InvalidGrantError("Invalid resource"));
    }
    if (resource && !sameResource(resource, recordedResource, this.resourceAliases)) {
      reject("resource_mismatch", new InvalidGrantError("Invalid resource"));
    }

    const requestedScopes = scopes ?? record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) {
      reject("scope_not_allowed", new AccessDeniedError("Refresh token cannot grant requested scopes"));
    }

    let tokens: OAuthTokens;
    try {
      tokens = await this.issueTokens(
        client.client_id,
        requestedScopes,
        recordedResource,
        refreshTokenHash,
        persistent ? { token: refreshToken, scopes: record.scopes } : undefined,
      );
    } catch (error) {
      if (error instanceof InvalidGrantError) reject("grant_unavailable", error);
      throw error;
    }
    const reason = resource && resourceUrlFromServerUrl(resource).href !== resourceUrlFromServerUrl(recordedResource).href
      ? "renewed_resource_alias" : "renewed";
    this.reportRefresh?.({ ...identity, outcome: "succeeded", reason });
    return tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.oauthStore.getAccessToken(hashToken(token));
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : this.resourceServerUrl,
      extra: { owner_id: LOCAL_OWNER_ID },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hashed = hashToken(request.token);
    this.oauthStore.deleteAccessToken(hashed);
    this.oauthStore.deleteRefreshToken(hashed);
  }

  close(): void {
    this.oauthStore.close();
  }

  isResourceAllowed(resource: URL): boolean {
    if (!resource) return false;
    return checkResourceAllowed({
      requestedResource: resource,
      configuredResource: this.resourceServerUrl,
    }) || this.allowedResourceUrls.has(resourceUrlFromServerUrl(resource).href)
      || this.allowedResourceUrls.has(resource.href)
      || this.resourceAliases.has(resource.href);
  }

  private validCodeRecord(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): AuthorizationCodeRecord {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record;
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource?: URL,
    consumedRefreshTokenHash?: string,
    retainedRefreshToken?: { token: string; scopes: string[] },
  ): Promise<OAuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = retainedRefreshToken?.token ?? randomToken();
    const accessExpiresAt = now + this.config.accessTokenTtlSeconds;
    const refreshExpiresAt = now + this.config.refreshTokenTtlSeconds;

    const saved = this.oauthStore.saveTokenPair(
      {
        accessTokenHash: hashToken(accessToken),
        accessToken: {
          clientId,
          scopes,
          expiresAt: accessExpiresAt,
          resource: resource?.href,
        },
        refreshTokenHash: hashToken(refreshToken),
        refreshToken: {
          clientId,
          scopes: retainedRefreshToken?.scopes ?? scopes,
          expiresAt: refreshExpiresAt,
          resource: resource?.href,
        },
      },
      consumedRefreshTokenHash,
    );
    if (!saved) {
      throw new InvalidGrantError("Invalid refresh token");
    }

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

function authorizationFormFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): Record<string, string | undefined> {
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scopes?.join(" "),
    state: params.state,
    resource: params.resource?.href,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function sameResource(left: URL, right: URL, aliases: Set<string>): boolean {
  if (resourceUrlFromServerUrl(left).href === resourceUrlFromServerUrl(right).href) return true;
  if (left.origin !== right.origin || left.search || right.search || left.hash || right.hash
      || left.username || left.password || right.username || right.password) return false;
  const root = new URL("/", left.origin).href;
  const endpoint = new URL("/mcp", left.origin).href;
  // 托管入口显式公布这两个地址；其他已允许的资源仍保留独立授权。
  return aliases.has(root) && aliases.has(endpoint)
    && (left.href === root || left.href === endpoint)
    && (right.href === root || right.href === endpoint);
}
