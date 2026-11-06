import { randomUUID } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export interface PersistedAccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedRefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedTokenPair {
  accessTokenHash: string;
  accessToken: PersistedAccessTokenRecord;
  refreshTokenHash: string;
  refreshToken: PersistedRefreshTokenRecord;
}

const GOOGLE_MCP_REDIRECT_HOST = /^oauth-redirect(?:-sandbox|-test|[1-9][0-9]?)?\.googleusercontent\.com$/u;

function isGoogleMcpRedirect(parsed: URL): boolean {
  return GOOGLE_MCP_REDIRECT_HOST.test(parsed.hostname)
    && parsed.protocol === "https:"
    && !parsed.username && !parsed.password && !parsed.hash && !parsed.search
    && /^\/(?:r|a)\/user_bound_custom-mcp-[a-zA-Z0-9_.-]+$/u.test(parsed.pathname);
}

export function usesGooglePersistentLinking(client: OAuthClientInformationFull): boolean {
  if (client.token_endpoint_auth_method !== "client_secret_post"
      && client.token_endpoint_auth_method !== "client_secret_basic") return false;
  return client.redirect_uris.length > 0 && client.redirect_uris.every((uri) => {
    try {
      return isGoogleMcpRedirect(new URL(uri));
    } catch {
      return false;
    }
  });
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
  // Gemini Web 注册的六个地址来自 production/test/sandbox 三个域，
  // 每个域都同时使用 /r/ 与 /a/。保持显式授权和固定回调用途。
  if (allowedHosts.includes("oauth-redirect.googleusercontent.com")
      && GOOGLE_MCP_REDIRECT_HOST.test(parsed.hostname)) {
    return isGoogleMcpRedirect(parsed);
  }
  return allowedHosts.includes(parsed.hostname);
}

export function createRegisteredOAuthClient(
  client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  allowedRedirectHosts: string[],
): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(String(uri), allowedRedirectHosts))) {
      throw new InvalidRequestError("Client redirect_uri is not allowed for this QuayMesh server");
    }

    const now = Math.floor(Date.now() / 1000);
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: `quaymesh-${randomUUID()}`,
      client_id_issued_at: now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
      grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: client.response_types ?? ["code"],
    };

    if (registered.client_secret && usesGooglePersistentLinking(registered)) {
      registered.client_secret_expires_at = 0;
    }

    return registered;
}

export type OAuthDataStore = Pick<SqliteOAuthStore, "getClient" | "registerClient" | "getAccessToken" | "getRefreshToken" | "saveTokenPair" | "deleteAccessToken" | "deleteRefreshToken" | "close">;

export class SqliteOAuthStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    const nowSeconds = Math.floor(Date.now() / 1000);
    this.deleteExpiredTokens(nowSeconds);
    this.retainGoogleClientSecrets(nowSeconds);
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.database.sqlite
      .prepare("select client_json from oauth_clients where client_id = ?")
      .get(clientId) as { client_json: string } | undefined;

    return row ? (JSON.parse(row.client_json) as OAuthClientInformationFull) : undefined;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
    allowedRedirectHosts: string[],
  ): OAuthClientInformationFull {
    const registered = createRegisteredOAuthClient(client, allowedRedirectHosts);
    const now = registered.client_id_issued_at ?? Math.floor(Date.now() / 1000);

    this.database.sqlite
      .prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)")
      .run(registered.client_id, JSON.stringify(registered), now);

    return registered;
  }

  saveAccessToken(tokenHash: string, record: PersistedAccessTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_access_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
      );
  }

  getAccessToken(tokenHash: string): PersistedAccessTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_access_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToAccessTokenRecord(row) : undefined;
  }

  deleteAccessToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where token_hash = ?").run(tokenHash);
  }

  saveRefreshToken(tokenHash: string, record: PersistedRefreshTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_refresh_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
      );
  }

  saveTokenPair(pair: PersistedTokenPair, consumedRefreshTokenHash?: string): boolean {
    const save = this.database.sqlite.transaction(() => {
      if (consumedRefreshTokenHash) {
        const result = this.database.sqlite
          .prepare("delete from oauth_refresh_tokens where token_hash = ?")
          .run(consumedRefreshTokenHash);
        if (result.changes !== 1) return false;
      }

      this.saveAccessToken(pair.accessTokenHash, pair.accessToken);
      this.saveRefreshToken(pair.refreshTokenHash, pair.refreshToken);
      return true;
    });

    return save.immediate();
  }

  getRefreshToken(tokenHash: string): PersistedRefreshTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_refresh_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToRefreshTokenRecord(row) : undefined;
  }

  deleteRefreshToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where token_hash = ?").run(tokenHash);
  }

  close(): void {
    this.database.close();
  }

  private retainGoogleClientSecrets(nowSeconds: number): void {
    const retain = this.database.sqlite.transaction(() => {
      const clients = this.database.sqlite
        .prepare("select client_id, client_json from oauth_clients")
        .all() as Array<{ client_id: string; client_json: string }>;
      const update = this.database.sqlite.prepare(
        "update oauth_clients set client_json = json_set(client_json, '$.client_secret_expires_at', 0) where client_id = ?",
      );
      for (const row of clients) {
        const client = JSON.parse(row.client_json) as OAuthClientInformationFull;
        const expiresAt = client.client_secret_expires_at;
        if (!client.client_secret || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)
            || expiresAt <= nowSeconds || !usesGooglePersistentLinking(client)) continue;
        update.run(row.client_id);
      }
    });
    retain.immediate();
  }

  private deleteExpiredTokens(nowSeconds: number): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where expires_at < ?").run(nowSeconds);
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where expires_at < ?").run(nowSeconds);
  }
}

export class SqliteOAuthClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly store: OAuthDataStore,
    private readonly allowedRedirectHosts: string[],
  ) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.store.getClient(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    return this.store.registerClient(client, this.allowedRedirectHosts);
  }
}

function rowToAccessTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedAccessTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}

function rowToRefreshTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedRefreshTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}
