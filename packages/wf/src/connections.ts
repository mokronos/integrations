import { timingSafeEqual } from "node:crypto"
import { mkdirSync } from "node:fs"
import { chmod, mkdir, open, readFile } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import type { SecretResolver } from "./core.ts"

export const ConnectionId = Schema.declare<string>(
  (value): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
).pipe(Schema.brand("ConnectionId"))
export type ConnectionId = typeof ConnectionId.Type

export const ConnectionStatus = Schema.Literals(["active", "reauthorization-required"])
export type ConnectionStatus = typeof ConnectionStatus.Type

export const OAuthConnection = Schema.Struct({
  id: ConnectionId,
  status: ConnectionStatus,
  resource: Schema.String,
  issuer: Schema.String,
  scopes: Schema.Array(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String
})
export type OAuthConnection = typeof OAuthConnection.Type

export const OAuthProtectedResourceMetadata = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String),
  scopes_supported: Schema.optional(Schema.Array(Schema.String)),
  bearer_methods_supported: Schema.optional(Schema.Array(Schema.String))
})
export type OAuthProtectedResourceMetadata = typeof OAuthProtectedResourceMetadata.Type

export const OAuthAuthorizationServerMetadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optional(Schema.String),
  scopes_supported: Schema.optional(Schema.Array(Schema.String)),
  response_types_supported: Schema.Array(Schema.String),
  grant_types_supported: Schema.optional(Schema.Array(Schema.String)),
  token_endpoint_auth_methods_supported: Schema.optional(Schema.Array(Schema.String)),
  code_challenge_methods_supported: Schema.optional(Schema.Array(Schema.String))
})
export type OAuthAuthorizationServerMetadata = typeof OAuthAuthorizationServerMetadata.Type

export const McpOAuthDiscovery = Schema.Struct({
  resourceMetadataUrl: Schema.String,
  resourceMetadata: OAuthProtectedResourceMetadata,
  authorizationServerMetadataUrl: Schema.String,
  authorizationServerMetadata: OAuthAuthorizationServerMetadata
})
export type McpOAuthDiscovery = typeof McpOAuthDiscovery.Type

export const OAuthClientConfiguration = Schema.Union([
  Schema.Struct({ type: Schema.Literal("dynamic") }),
  Schema.Struct({
    type: Schema.Literal("static"),
    clientId: Schema.String,
    clientSecret: Schema.optional(Schema.String),
    tokenEndpointAuthMethod: Schema.optional(Schema.Literals([
      "none",
      "client_secret_basic",
      "client_secret_post"
    ]))
  })
])
export type OAuthClientConfiguration = typeof OAuthClientConfiguration.Type

const OAuthClientRegistration = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optional(Schema.String),
  token_endpoint_auth_method: Schema.optional(Schema.Literals([
    "none",
    "client_secret_basic",
    "client_secret_post"
  ]))
})

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.optional(Schema.Number),
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String)
})

const OAuthErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
  error_uri: Schema.optional(Schema.String)
})

const StoredOAuthCredentials = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  tokenType: Schema.String,
  expiresAt: Schema.optional(Schema.Number),
  clientId: Schema.String,
  clientSecret: Schema.optional(Schema.String),
  tokenEndpoint: Schema.String,
  tokenEndpointAuthMethod: Schema.Literals(["none", "client_secret_basic", "client_secret_post"]),
  resource: Schema.String,
  issuer: Schema.String,
  scopes: Schema.Array(Schema.String)
})
type StoredOAuthCredentials = typeof StoredOAuthCredentials.Type

const StoredOAuthCredentialsJson = Schema.fromJsonString(StoredOAuthCredentials)
const ScopesJson = Schema.fromJsonString(Schema.Array(Schema.String))

const ConnectionRow = Schema.Struct({
  id: Schema.String,
  status: ConnectionStatus,
  resource: Schema.String,
  issuer: Schema.String,
  scopes_json: Schema.String,
  expires_at: Schema.NullOr(Schema.Number),
  sealed_credentials: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String
})
type ConnectionRow = typeof ConnectionRow.Type

export class ConnectionAuthorizationError extends Schema.TaggedErrorClass<ConnectionAuthorizationError>()(
  "ConnectionAuthorizationError",
  {
    connectionId: ConnectionId,
    message: Schema.String
  }
) {}

export interface TokenProtector {
  readonly seal: (plaintext: string) => Promise<string>
  readonly open: (sealed: string) => Promise<string>
}

const randomBytes = (length: number): Uint8Array<ArrayBuffer> =>
  crypto.getRandomValues(new Uint8Array(length))
const base64Url = (value: Uint8Array): string => Buffer.from(value).toString("base64url")
const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(value, "base64url")
  const bytes = new Uint8Array(decoded.byteLength)
  bytes.set(decoded)
  return bytes
}
const keyAdditionalData = new TextEncoder().encode("@mokronos/wfkit/oauth-credentials/v1")

const isFileExistsError = (error: Error): boolean => "code" in error && error.code === "EEXIST"

export const createFileTokenProtector = (keyPath: string): TokenProtector => {
  let keyPromise: Promise<CryptoKey> | undefined

  const key = (): Promise<CryptoKey> => {
    if (keyPromise !== undefined) return keyPromise
    keyPromise = (async () => {
      const resolvedPath = path.resolve(keyPath)
      await mkdir(path.dirname(resolvedPath), { recursive: true })
      try {
        const handle = await open(resolvedPath, "wx", 0o600)
        try {
          await handle.writeFile(`${base64Url(randomBytes(32))}\n`, "utf8")
        } finally {
          await handle.close()
        }
      } catch (error) {
        if (!(error instanceof Error) || !isFileExistsError(error)) throw error
      }
      await chmod(resolvedPath, 0o600)
      const keyBytes = fromBase64Url((await readFile(resolvedPath, "utf8")).trim())
      if (keyBytes.byteLength !== 32) {
        throw new Error(`Invalid wf connection key at ${resolvedPath}`)
      }
      return await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
    })()
    return keyPromise
  }

  return {
    async seal(plaintext) {
      const initializationVector = randomBytes(12)
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: initializationVector, additionalData: keyAdditionalData },
        await key(),
        new TextEncoder().encode(plaintext)
      )
      return `v1.${base64Url(initializationVector)}.${base64Url(new Uint8Array(ciphertext))}`
    },

    async open(sealed) {
      const [version, encodedInitializationVector, encodedCiphertext, extra] = sealed.split(".")
      if (
        version !== "v1" ||
        encodedInitializationVector === undefined ||
        encodedCiphertext === undefined ||
        extra !== undefined
      ) {
        throw new Error("Unsupported wf connection credential format")
      }
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64Url(encodedInitializationVector),
          additionalData: keyAdditionalData
        },
        await key(),
        fromBase64Url(encodedCiphertext)
      )
      return new TextDecoder().decode(plaintext)
    }
  }
}

interface ConnectionRepository {
  readonly list: () => ReadonlyArray<OAuthConnection>
  readonly get: (id: string) => OAuthConnection | undefined
  readonly readCredentials: (id: ConnectionId) => Promise<StoredOAuthCredentials | undefined>
  readonly save: (connection: OAuthConnection, credentials: StoredOAuthCredentials) => Promise<void>
  readonly markReauthorizationRequired: (id: ConnectionId) => void
  readonly delete: (id: ConnectionId) => boolean
}

const connectionFromRow = (row: ConnectionRow): OAuthConnection => ({
  id: Schema.decodeUnknownSync(ConnectionId)(row.id),
  status: row.status,
  resource: row.resource,
  issuer: row.issuer,
  scopes: Schema.decodeUnknownSync(ScopesJson)(row.scopes_json),
  ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const createConnectionRepository = (options: {
  readonly databasePath: string
  readonly protector: TokenProtector
}): ConnectionRepository => {
  const databasePath = path.resolve(options.databasePath)
  mkdirSync(path.dirname(databasePath), { recursive: true })
  const db = new Database(databasePath, { create: true, readwrite: true })
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS wf_connections (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('active', 'reauthorization-required')),
      resource TEXT NOT NULL,
      issuer TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      expires_at INTEGER,
      sealed_credentials TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  const row = (id: string): ConnectionRow | undefined => {
    const value = db.query<ConnectionRow, [string]>(`
      SELECT id, status, resource, issuer, scopes_json, expires_at,
        sealed_credentials, created_at, updated_at
      FROM wf_connections
      WHERE id = ?
    `).get(id)
    return value === null ? undefined : Schema.decodeUnknownSync(ConnectionRow)(value)
  }

  return {
    list() {
      return db.query<ConnectionRow, []>(`
        SELECT id, status, resource, issuer, scopes_json, expires_at,
          sealed_credentials, created_at, updated_at
        FROM wf_connections
        ORDER BY id
      `).all().map((value) => connectionFromRow(Schema.decodeUnknownSync(ConnectionRow)(value)))
    },

    get(id) {
      const value = row(id)
      return value === undefined ? undefined : connectionFromRow(value)
    },

    async readCredentials(id) {
      const value = row(id)
      if (value?.sealed_credentials === null || value?.sealed_credentials === undefined) return undefined
      return Schema.decodeUnknownSync(StoredOAuthCredentialsJson)(
        await options.protector.open(value.sealed_credentials)
      )
    },

    async save(connection, credentials) {
      const sealedCredentials = await options.protector.seal(
        Schema.encodeSync(StoredOAuthCredentialsJson)(credentials)
      )
      db.query<never, [string, ConnectionStatus, string, string, string, number | null, string, string, string]>(`
        INSERT INTO wf_connections (
          id, status, resource, issuer, scopes_json, expires_at,
          sealed_credentials, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          resource = excluded.resource,
          issuer = excluded.issuer,
          scopes_json = excluded.scopes_json,
          expires_at = excluded.expires_at,
          sealed_credentials = excluded.sealed_credentials,
          updated_at = excluded.updated_at
      `).run(
        connection.id,
        connection.status,
        connection.resource,
        connection.issuer,
        Schema.encodeSync(ScopesJson)(connection.scopes),
        connection.expiresAt ?? null,
        sealedCredentials,
        connection.createdAt,
        connection.updatedAt
      )
    },

    markReauthorizationRequired(id) {
      db.query<never, [string, string]>(`
        UPDATE wf_connections
        SET status = 'reauthorization-required', sealed_credentials = NULL, updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), id)
    },

    delete(id) {
      return db.query<never, [string]>("DELETE FROM wf_connections WHERE id = ?").run(id).changes > 0
    }
  }
}

const loopbackHostnames = new Set(["127.0.0.1", "[::1]", "::1", "localhost"])

const secureUrl = (value: string, label: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} is not a valid URL: ${value}`)
  }
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new Error(`${label} must not include credentials or a fragment`)
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHostnames.has(url.hostname))) {
    throw new Error(`${label} must use HTTPS (HTTP is allowed only for loopback testing)`)
  }
  return url
}

const normalizedResource = (value: string): string => {
  const url = secureUrl(value, "OAuth resource")
  if (url.pathname === "/") url.pathname = ""
  return url.toString()
}

const resourceMetadataFromChallenge = (header: string | null): string | undefined => {
  if (header === null || !/^Bearer\s/i.test(header)) return undefined
  const match = /(?:^|,\s*)resource_metadata=(?:"([^"]+)"|([^,\s]+))/i.exec(header)
  return match?.[1] ?? match?.[2]
}

const protectedResourceMetadataUrl = (resource: URL): URL => {
  const metadata = new URL(resource.origin)
  const resourcePath = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "")
  metadata.pathname = `/.well-known/oauth-protected-resource${resourcePath}`
  return metadata
}

const authorizationServerMetadataUrl = (issuer: URL): URL => {
  const metadata = new URL(issuer.origin)
  const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "")
  metadata.pathname = `/.well-known/oauth-authorization-server${issuerPath}`
  return metadata
}

const oauthErrorMessage = async (response: Response, context: string): Promise<string> => {
  try {
    const error = await Schema.decodeUnknownPromise(OAuthErrorResponse)(await response.json())
    return `${context}: ${error.error}`
  } catch {
    return `${context}: HTTP ${response.status} ${response.statusText}`
  }
}

const decodeJsonResponse = async <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  response: Response,
  context: string
): Promise<A> => {
  if (!response.ok) throw new Error(await oauthErrorMessage(response, context))
  try {
    return await Schema.decodeUnknownPromise(schema)(await response.json())
  } catch {
    throw new Error(`${context}: invalid JSON response`)
  }
}

export const discoverMcpOAuth = async (resourceValue: string): Promise<McpOAuthDiscovery> => {
  const resourceUrl = secureUrl(resourceValue, "MCP server URL")
  const challengeResponse = await fetch(resourceUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "@mokronos/wfkit", version: "0.2.0" }
      }
    })
  })

  const advertisedMetadata = resourceMetadataFromChallenge(
    challengeResponse.headers.get("www-authenticate")
  )
  if (challengeResponse.status !== 401 && advertisedMetadata === undefined) {
    throw new Error(`MCP server did not advertise OAuth authorization (HTTP ${challengeResponse.status})`)
  }

  const resourceMetadataUrl = secureUrl(
    advertisedMetadata ?? protectedResourceMetadataUrl(resourceUrl).toString(),
    "OAuth protected resource metadata URL"
  )
  const resourceMetadataResponse = await fetch(resourceMetadataUrl)
  const resourceMetadata = await decodeJsonResponse(
    OAuthProtectedResourceMetadata,
    resourceMetadataResponse,
    "OAuth protected resource metadata discovery failed"
  )
  if (normalizedResource(resourceMetadata.resource) !== normalizedResource(resourceUrl.toString())) {
    throw new Error(
      `OAuth protected resource metadata identifies ${resourceMetadata.resource}, expected ${normalizedResource(resourceUrl.toString())}`
    )
  }
  const issuerValue = resourceMetadata.authorization_servers[0]
  if (issuerValue === undefined) {
    throw new Error("OAuth protected resource metadata has no authorization server")
  }
  const issuer = secureUrl(issuerValue, "OAuth issuer")
  const serverMetadataUrl = authorizationServerMetadataUrl(issuer)
  const serverMetadataResponse = await fetch(serverMetadataUrl)
  const serverMetadata = await decodeJsonResponse(
    OAuthAuthorizationServerMetadata,
    serverMetadataResponse,
    "OAuth authorization server metadata discovery failed"
  )

  if (serverMetadata.issuer !== issuerValue) {
    throw new Error(`OAuth issuer mismatch: metadata returned ${serverMetadata.issuer}, expected ${issuerValue}`)
  }
  secureUrl(serverMetadata.authorization_endpoint, "OAuth authorization endpoint")
  secureUrl(serverMetadata.token_endpoint, "OAuth token endpoint")
  if (!serverMetadata.response_types_supported.includes("code")) {
    throw new Error("OAuth authorization server does not support the authorization code response type")
  }
  if (
    serverMetadata.grant_types_supported !== undefined &&
    !serverMetadata.grant_types_supported.includes("authorization_code")
  ) {
    throw new Error("OAuth authorization server does not support the authorization code grant")
  }
  if (!serverMetadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("OAuth authorization server does not advertise PKCE S256 support")
  }

  return {
    resourceMetadataUrl: resourceMetadataUrl.toString(),
    resourceMetadata,
    authorizationServerMetadataUrl: serverMetadataUrl.toString(),
    authorizationServerMetadata: serverMetadata
  }
}

const pkceChallenge = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

const tokenRequestHeadersAndBody = (options: {
  readonly clientId: string
  readonly clientSecret?: string
  readonly tokenEndpointAuthMethod: StoredOAuthCredentials["tokenEndpointAuthMethod"]
  readonly parameters: URLSearchParams
}): { readonly headers: Record<string, string>; readonly body: URLSearchParams } => {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" }
  options.parameters.set("client_id", options.clientId)
  if (options.tokenEndpointAuthMethod === "client_secret_post") {
    if (options.clientSecret === undefined) throw new Error("OAuth client_secret_post requires a client secret")
    options.parameters.set("client_secret", options.clientSecret)
  }
  if (options.tokenEndpointAuthMethod === "client_secret_basic") {
    if (options.clientSecret === undefined) throw new Error("OAuth client_secret_basic requires a client secret")
    headers["authorization"] = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`, "utf8").toString("base64")}`
  }
  return { headers, body: options.parameters }
}

const scopesFromToken = (scope: string | undefined, requested: ReadonlyArray<string>): ReadonlyArray<string> =>
  scope === undefined
    ? requested
    : scope.split(/\s+/).map((value) => value.trim()).filter((value) => value.length > 0)

const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8")
  const rightBytes = Buffer.from(right, "utf8")
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

export interface OAuthAuthorizationAttempt {
  readonly authorizationUrl: string
  readonly connectionId: ConnectionId
  readonly complete: (callbackUrl: string) => Promise<OAuthConnection>
}

export interface BeginMcpOAuthOptions {
  readonly connectionId: string
  readonly resource: string
  readonly redirectUri: string
  readonly scopes?: ReadonlyArray<string>
  readonly client?: OAuthClientConfiguration
}

export interface ConnectionManager {
  readonly list: () => ReadonlyArray<OAuthConnection>
  readonly get: (id: string) => OAuthConnection | undefined
  readonly beginMcpOAuth: (options: BeginMcpOAuthOptions) => Promise<OAuthAuthorizationAttempt>
  readonly disconnect: (id: string) => boolean
  readonly secretResolver: (fallback?: SecretResolver) => SecretResolver
}

export interface ConnectionManagerOptions {
  readonly databasePath: string
  readonly keyPath: string
  readonly refreshSkewMs?: number
  readonly protector?: TokenProtector
}

export const createConnectionManager = (options: ConnectionManagerOptions): ConnectionManager => {
  const repository = createConnectionRepository({
    databasePath: options.databasePath,
    protector: options.protector ?? createFileTokenProtector(options.keyPath)
  })
  const refreshSkewMs = Math.max(0, options.refreshSkewMs ?? 30_000)
  const pendingRefreshes = new Map<ConnectionId, Promise<string>>()

  const refresh = async (
    connection: OAuthConnection,
    credentials: StoredOAuthCredentials
  ): Promise<string> => {
    if (credentials.refreshToken === undefined) {
      repository.markReauthorizationRequired(connection.id)
      throw new ConnectionAuthorizationError({
        connectionId: connection.id,
        message: `Connection ${connection.id} has expired and must be authorized again`
      })
    }
    const parameters = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      resource: credentials.resource
    })
    const request = tokenRequestHeadersAndBody({
      clientId: credentials.clientId,
      ...(credentials.clientSecret === undefined ? {} : { clientSecret: credentials.clientSecret }),
      tokenEndpointAuthMethod: credentials.tokenEndpointAuthMethod,
      parameters
    })
    const response = await fetch(credentials.tokenEndpoint, {
      method: "POST",
      headers: request.headers,
      body: request.body
    })
    if (!response.ok) {
      let authorizationRequired = response.status === 400 || response.status === 401
      try {
        const oauthError = await Schema.decodeUnknownPromise(OAuthErrorResponse)(await response.clone().json())
        authorizationRequired = oauthError.error === "invalid_grant" || oauthError.error === "invalid_client"
      } catch {
        // The status is still enough to avoid persisting or printing a response body.
      }
      if (authorizationRequired) repository.markReauthorizationRequired(connection.id)
      throw new ConnectionAuthorizationError({
        connectionId: connection.id,
        message: authorizationRequired
          ? `Connection ${connection.id} must be authorized again`
          : `Connection ${connection.id} token refresh failed with HTTP ${response.status}`
      })
    }
    let token: typeof OAuthTokenResponse.Type
    try {
      token = await Schema.decodeUnknownPromise(OAuthTokenResponse)(await response.json())
    } catch {
      throw new ConnectionAuthorizationError({
        connectionId: connection.id,
        message: `Connection ${connection.id} token refresh returned an invalid response`
      })
    }
    if (token.token_type.toLowerCase() !== "bearer") {
      throw new ConnectionAuthorizationError({
        connectionId: connection.id,
        message: `Connection ${connection.id} returned unsupported token type ${token.token_type}`
      })
    }
    const now = Date.now()
    const scopes = scopesFromToken(token.scope, credentials.scopes)
    const expiresAt = token.expires_in === undefined
      ? undefined
      : now + Math.max(0, token.expires_in) * 1000
    const refreshToken = token.refresh_token ?? credentials.refreshToken
    const updatedCredentials: StoredOAuthCredentials = {
      accessToken: token.access_token,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      tokenType: token.token_type,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      clientId: credentials.clientId,
      ...(credentials.clientSecret === undefined ? {} : { clientSecret: credentials.clientSecret }),
      tokenEndpoint: credentials.tokenEndpoint,
      tokenEndpointAuthMethod: credentials.tokenEndpointAuthMethod,
      resource: credentials.resource,
      issuer: credentials.issuer,
      scopes
    }
    const updatedConnection: OAuthConnection = {
      id: connection.id,
      status: "active",
      resource: connection.resource,
      issuer: connection.issuer,
      scopes,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      createdAt: connection.createdAt,
      updatedAt: new Date(now).toISOString()
    }
    await repository.save(updatedConnection, updatedCredentials)
    return token.access_token
  }

  const resolveConnection = async (connection: OAuthConnection): Promise<string> => {
    if (connection.status !== "active") {
      throw new ConnectionAuthorizationError({
        connectionId: connection.id,
        message: `Connection ${connection.id} must be authorized again`
      })
    }
    const credentials = await repository.readCredentials(connection.id)
    if (credentials === undefined) {
      throw new ConnectionAuthorizationError({
        connectionId: connection.id,
        message: `Connection ${connection.id} has no stored credentials`
      })
    }
    if (credentials.expiresAt === undefined || credentials.expiresAt > Date.now() + refreshSkewMs) {
      return credentials.accessToken
    }
    const pending = pendingRefreshes.get(connection.id)
    if (pending !== undefined) return await pending
    const started = refresh(connection, credentials).finally(() => pendingRefreshes.delete(connection.id))
    pendingRefreshes.set(connection.id, started)
    return await started
  }

  return {
    list: repository.list,
    get: repository.get,

    async beginMcpOAuth(beginOptions) {
      const connectionId = Schema.decodeUnknownSync(ConnectionId)(beginOptions.connectionId)
      const redirectUri = secureUrl(beginOptions.redirectUri, "OAuth redirect URI")
      if (!loopbackHostnames.has(redirectUri.hostname)) {
        throw new Error("wf OAuth redirects must use a loopback address")
      }
      const discovery = await discoverMcpOAuth(beginOptions.resource)
      const metadata = discovery.authorizationServerMetadata
      const requestedScopes = Array.from(new Set(
        (beginOptions.scopes ?? []).map((scope) => scope.trim()).filter((scope) => scope.length > 0)
      ))
      const client = beginOptions.client ?? { type: "dynamic" }
      let clientId: string
      let clientSecret: string | undefined
      let tokenEndpointAuthMethod: StoredOAuthCredentials["tokenEndpointAuthMethod"]

      if (client.type === "static") {
        clientId = client.clientId
        clientSecret = client.clientSecret
        tokenEndpointAuthMethod = client.tokenEndpointAuthMethod ?? (clientSecret === undefined ? "none" : "client_secret_basic")
      } else {
        if (metadata.registration_endpoint === undefined) {
          throw new Error("OAuth server does not support dynamic client registration; provide a registered client id")
        }
        const registrationEndpoint = secureUrl(metadata.registration_endpoint, "OAuth registration endpoint")
        const registrationResponse = await fetch(registrationEndpoint, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            redirect_uris: [redirectUri.toString()],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            client_name: "wf local workflow agent"
          })
        })
        const registration = await decodeJsonResponse(
          OAuthClientRegistration,
          registrationResponse,
          "OAuth dynamic client registration failed"
        )
        clientId = registration.client_id
        clientSecret = registration.client_secret
        tokenEndpointAuthMethod = registration.token_endpoint_auth_method ??
          (clientSecret === undefined ? "none" : "client_secret_basic")
      }

      const verifier = base64Url(randomBytes(32))
      const state = base64Url(randomBytes(32))
      const authorizationUrl = secureUrl(metadata.authorization_endpoint, "OAuth authorization endpoint")
      authorizationUrl.searchParams.set("response_type", "code")
      authorizationUrl.searchParams.set("client_id", clientId)
      authorizationUrl.searchParams.set("redirect_uri", redirectUri.toString())
      authorizationUrl.searchParams.set("state", state)
      authorizationUrl.searchParams.set("code_challenge", await pkceChallenge(verifier))
      authorizationUrl.searchParams.set("code_challenge_method", "S256")
      authorizationUrl.searchParams.set("resource", discovery.resourceMetadata.resource)
      if (requestedScopes.length > 0) authorizationUrl.searchParams.set("scope", requestedScopes.join(" "))

      let consumed = false
      const attemptExpiresAt = Date.now() + 10 * 60 * 1000
      return {
        authorizationUrl: authorizationUrl.toString(),
        connectionId,
        async complete(callbackValue) {
          if (consumed) throw new Error("OAuth authorization callback was already consumed")
          if (Date.now() > attemptExpiresAt) {
            consumed = true
            throw new Error("OAuth authorization callback expired; start the connection again")
          }
          const callbackUrl = secureUrl(callbackValue, "OAuth callback URL")
          if (callbackUrl.origin !== redirectUri.origin || callbackUrl.pathname !== redirectUri.pathname) {
            throw new Error("OAuth callback URL does not match the registered redirect URI")
          }
          const returnedState = callbackUrl.searchParams.get("state")
          if (returnedState === null || !constantTimeEqual(returnedState, state)) {
            throw new Error("OAuth callback state did not match the authorization request")
          }
          const returnedIssuer = callbackUrl.searchParams.get("iss")
          if (returnedIssuer !== null && returnedIssuer !== metadata.issuer) {
            throw new Error("OAuth callback issuer did not match the discovered authorization server")
          }
          const callbackError = callbackUrl.searchParams.get("error")
          if (callbackError !== null) {
            consumed = true
            const description = callbackUrl.searchParams.get("error_description")
            throw new Error(`OAuth authorization failed: ${callbackError}${description === null ? "" : ` (${description})`}`)
          }
          const code = callbackUrl.searchParams.get("code")
          if (code === null || code.length === 0) throw new Error("OAuth callback did not include an authorization code")
          consumed = true

          const parameters = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri.toString(),
            code_verifier: verifier,
            resource: discovery.resourceMetadata.resource
          })
          const request = tokenRequestHeadersAndBody({
            clientId,
            ...(clientSecret === undefined ? {} : { clientSecret }),
            tokenEndpointAuthMethod,
            parameters
          })
          const tokenEndpoint = secureUrl(metadata.token_endpoint, "OAuth token endpoint")
          const tokenResponse = await fetch(tokenEndpoint, {
            method: "POST",
            headers: request.headers,
            body: request.body
          })
          const token = await decodeJsonResponse(
            OAuthTokenResponse,
            tokenResponse,
            "OAuth authorization code exchange failed"
          )
          if (token.token_type.toLowerCase() !== "bearer") {
            throw new Error(`OAuth server returned unsupported token type ${token.token_type}`)
          }
          const now = Date.now()
          const scopes = scopesFromToken(token.scope, requestedScopes)
          const credentials: StoredOAuthCredentials = {
            accessToken: token.access_token,
            ...(token.refresh_token === undefined ? {} : { refreshToken: token.refresh_token }),
            tokenType: token.token_type,
            ...(token.expires_in === undefined ? {} : { expiresAt: now + Math.max(0, token.expires_in) * 1000 }),
            clientId,
            ...(clientSecret === undefined ? {} : { clientSecret }),
            tokenEndpoint: tokenEndpoint.toString(),
            tokenEndpointAuthMethod,
            resource: discovery.resourceMetadata.resource,
            issuer: metadata.issuer,
            scopes
          }
          const existing = repository.get(connectionId)
          const connection: OAuthConnection = {
            id: connectionId,
            status: "active",
            resource: discovery.resourceMetadata.resource,
            issuer: metadata.issuer,
            scopes,
            ...(credentials.expiresAt === undefined ? {} : { expiresAt: credentials.expiresAt }),
            createdAt: existing?.createdAt ?? new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString()
          }
          await repository.save(connection, credentials)
          return connection
        }
      }
    },

    disconnect(id) {
      return repository.delete(Schema.decodeUnknownSync(ConnectionId)(id))
    },

    secretResolver(fallback) {
      return {
        async resolve(name, context) {
          const connection = repository.get(name)
          if (connection !== undefined) {
            if (context?.resource === undefined) {
              throw new ConnectionAuthorizationError({
                connectionId: connection.id,
                message: `Connection ${connection.id} can only be resolved for its authorized resource`
              })
            }
            if (normalizedResource(context.resource) !== normalizedResource(connection.resource)) {
              throw new ConnectionAuthorizationError({
                connectionId: connection.id,
                message: `Connection ${connection.id} is authorized for ${connection.resource}, not ${context.resource}`
              })
            }
            return await resolveConnection(connection)
          }
          if (fallback !== undefined) return await fallback.resolve(name, context)
          throw new Error(`Connection or secret not found: ${name}`)
        }
      }
    }
  }
}

export const connectionManagerPaths = (storageDir: string): {
  readonly databasePath: string
  readonly keyPath: string
} => ({
  databasePath: path.join(storageDir, "connections.sqlite"),
  keyPath: path.join(storageDir, "connections.key")
})
