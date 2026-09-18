import {
  ClientId,
  OAuthGrantId,
  whenPresent,
  webCryptoLayer
} from "@mokronos/integrations-contracts"
import type { Client } from "@mokronos/integrations-contracts"
import {
  hashSessionToken,
  authenticateClient,
  defaultLocalSubjectId,
  newOAuthAccessToken,
  newOAuthApplicationId,
  newOAuthAuthorizationCode,
  newOAuthGrantId,
  newOAuthRefreshToken,
  newOAuthRequestId,
  newOAuthTokenFamilyId,
  OAuthSecretHash,
  sha256Base64Url,
  sha256Hex
} from "@mokronos/integrations-gateway-core"
import type { GatewayStore, OAuthActor } from "@mokronos/integrations-gateway-core"
import { Crypto, DateTime, Duration, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import type { GatewaySettings } from "./services.ts"

const ClientMetadata = Schema.Struct({
  client_id: Schema.optional(Schema.String),
  client_name: Schema.String.check(Schema.isMinLength(1)),
  redirect_uris: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  client_uri: Schema.optional(Schema.String),
  logo_uri: Schema.optional(Schema.String),
  grant_types: Schema.optional(Schema.Array(Schema.String)),
  response_types: Schema.optional(Schema.Array(Schema.String)),
  token_endpoint_auth_method: Schema.optional(Schema.String),
  application_type: Schema.optional(Schema.String)
})

const DcrMetadata = Schema.Struct({
  client_name: Schema.String.check(Schema.isMinLength(1)),
  redirect_uris: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  client_uri: Schema.optional(Schema.String),
  logo_uri: Schema.optional(Schema.String),
  grant_types: Schema.optional(Schema.Array(Schema.String)),
  response_types: Schema.optional(Schema.Array(Schema.String)),
  token_endpoint_auth_method: Schema.optional(Schema.String),
  application_type: Schema.optional(Schema.String)
})

const ConsentDecision = Schema.Union([
  Schema.Struct({ decision: Schema.Literal("deny") }),
  Schema.Struct({ decision: Schema.Literal("approve"), clientId: ClientId })
])

class OAuthClientMetadataError extends Schema.TaggedError<OAuthClientMetadataError>()(
  "OAuthClientMetadataError",
  { message: Schema.String }
) {}

type OAuthRuntime = ManagedRuntime.ManagedRuntime<HttpClient.HttpClient | Crypto.Crypto, never>

const json = <A>(body: A, status = 200, headers: HeadersInit = {}): Response =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...headers
    }
  })

const oauthError = (error: string, description: string, status = 400): Response =>
  json({ error, error_description: description }, status)

const sessionCookie = (request: Request): string | undefined => {
  const header = request.headers.get("cookie")
  if (header === null) return undefined
  for (const part of header.split(";")) {
    const [name, ...value] = part.split("=")
    if (name?.trim() === "wf_session") return value.join("=").trim() || undefined
  }
  return undefined
}

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"

const isPrivateHost = (hostname: string): boolean => {
  if (isLoopback(hostname) || hostname === "0.0.0.0" || hostname.endsWith(".local")) return true
  if (hostname === "169.254.169.254" || hostname.startsWith("10.") || hostname.startsWith("192.168.")) return true
  const match = /^172\.(\d+)\./.exec(hostname)
  return match?.[1] !== undefined && Number(match[1]) >= 16 && Number(match[1]) <= 31
}

const parsedUrl = (value: string): URL | undefined => {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

const validRedirectUri = (value: string): boolean => {
  const url = parsedUrl(value)
  if (url === undefined || url.hash !== "" || url.username !== "" || url.password !== "") return false
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname))
}

const validCimdIdentifier = (value: string): URL | undefined => {
  const url = parsedUrl(value)
  if (
    url === undefined || url.protocol !== "https:" || url.pathname === "/" || url.hash !== "" ||
    url.username !== "" || url.password !== "" || isPrivateHost(url.hostname)
  ) return undefined
  return url
}

const safeMetadata = (metadata: typeof ClientMetadata.Type): boolean =>
  metadata.redirect_uris.every(validRedirectUri) &&
  (metadata.token_endpoint_auth_method === undefined || metadata.token_endpoint_auth_method === "none") &&
  (metadata.response_types === undefined || (
    metadata.response_types.includes("code") && metadata.response_types.every((type) => type === "code")
  )) &&
  (metadata.grant_types === undefined || (
    metadata.grant_types.includes("authorization_code") &&
    metadata.grant_types.every((type) => type === "authorization_code" || type === "refresh_token")
  ))

const validPkceValue = (value: string): boolean => /^[A-Za-z0-9._~-]{43,128}$/.test(value)

const metadataJson = (metadata: typeof ClientMetadata.Type): typeof Schema.Json.Type => ({
  client_name: metadata.client_name,
  redirect_uris: metadata.redirect_uris,
  ...whenPresent("client_id", metadata.client_id),
  ...whenPresent("client_uri", metadata.client_uri),
  ...whenPresent("logo_uri", metadata.logo_uri),
  ...whenPresent("grant_types", metadata.grant_types),
  ...whenPresent("response_types", metadata.response_types),
  ...whenPresent("token_endpoint_auth_method", metadata.token_endpoint_auth_method),
  ...whenPresent("application_type", metadata.application_type)
})

const sameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("origin")
  if (origin === null) return true
  return parsedUrl(origin)?.origin === new URL(request.url).origin
}

const bearerChallenge = (metadataUrl: string, error?: string): string =>
  `Bearer resource_metadata="${metadataUrl}", scope="mcp"${error === undefined ? "" : `, error="${error}"`}`

export interface McpOAuthAuthentication {
  readonly client: Client
  readonly actor: OAuthActor
  readonly expiresAt: Date
  readonly scope: "mcp"
}

export interface McpOAuthHandle {
  readonly enabled: boolean
  readonly resource: string | undefined
  readonly metadataUrl: string | undefined
  handle(request: Request, context?: { readonly localSecret?: string; readonly remoteAddress?: string }): Promise<Response | undefined>
  authenticate(token: string): Promise<McpOAuthAuthentication | undefined>
  challenge(error?: string): string
  dispose(): Promise<void>
}

export const createMcpOAuthHandler = (options: {
  readonly store: GatewayStore
  readonly settings: GatewaySettings
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
  readonly registrationLimitPerMinute?: number
}): McpOAuthHandle => {
  const resource = options.settings.mcpUrl?.()
  const resourceUrl = resource === undefined ? undefined : parsedUrl(resource)
  const enabled = resourceUrl !== undefined && (
    resourceUrl.protocol === "https:" || (resourceUrl.protocol === "http:" && isLoopback(resourceUrl.hostname))
  )
  const issuer = enabled && resourceUrl !== undefined ? resourceUrl.origin : undefined
  const metadataUrl = enabled && resourceUrl !== undefined
    ? `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`
    : undefined
  const runtime: OAuthRuntime = ManagedRuntime.make(Layer.merge(options.httpClient, webCryptoLayer))
  const store = options.store
  const registrationWindows = new Map<string, number>()
  let registrationMinute = -1

  const registrationAllowed = (remoteAddress: string | undefined): boolean => {
    const limit = options.registrationLimitPerMinute
    if (limit === undefined) return true
    const key = remoteAddress ?? "unidentified"
    const minute = Math.floor(Date.now() / 60_000)
    if (registrationMinute !== minute) {
      registrationWindows.clear()
      registrationMinute = minute
    }
    const count = (registrationWindows.get(key) ?? 0) + 1
    registrationWindows.set(key, count)
    return count <= limit
  }

  const applicationFor = (clientIdentifier: string) => Effect.gen(function*() {
    const cimdUrl = validCimdIdentifier(clientIdentifier)
    if (cimdUrl === undefined) return yield* store.findOAuthApplication(clientIdentifier)
    const http = yield* HttpClient.HttpClient
    const metadata = yield* http.get(cimdUrl).pipe(
      Effect.flatMap((response) => {
        const length = Number(response.headers["content-length"] ?? 0)
        return length > 64 * 1024
          ? Effect.fail(new OAuthClientMetadataError({ message: "Client metadata is too large" }))
          : Effect.succeed(response)
      }),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(ClientMetadata)),
      Effect.timeout("5 seconds")
    )
    if (metadata.client_id !== clientIdentifier || !safeMetadata(metadata)) {
      return yield* new OAuthClientMetadataError({ message: "Client metadata is not valid for this authorization server" })
    }
    const existing = yield* store.findOAuthApplication(clientIdentifier)
    return yield* store.upsertOAuthApplication({
      id: existing?.id ?? (yield* newOAuthApplicationId),
      kind: "cimd",
      clientIdentifier,
      name: metadata.client_name,
      redirectUris: metadata.redirect_uris,
      metadata: metadataJson(metadata)
    })
  })

  const currentSession = (request: Request, context?: { readonly localSecret?: string }) => Effect.gen(function*() {
    const secret = sessionCookie(request)
    if (secret !== undefined) return yield* store.findLiveSession(yield* hashSessionToken(secret))
    if (context?.localSecret === undefined) return undefined
    const authentication = yield* authenticateClient(store, context.localSecret)
    if (authentication.status !== "authenticated") return undefined
    return {
      tenantId: authentication.client.tenantId,
      subjectId: defaultLocalSubjectId,
      email: `local:${authentication.client.name}`
    }
  })

  const protectedResourceMetadata = () => json({
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"]
  })

  const authorizationServerMetadata = () => json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true
  })

  const register = (request: Request) => Effect.gen(function*() {
    const declared = Number(request.headers.get("content-length") ?? 0)
    if (declared > 64 * 1024) return oauthError("invalid_client_metadata", "Registration is too large", 413)
    const text = yield* Effect.promise(() => request.text())
    if (text.length > 64 * 1024) return oauthError("invalid_client_metadata", "Registration is too large", 413)
    const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(DcrMetadata))(text)
    if (Exit.isFailure(decoded) || !safeMetadata(decoded.value)) {
      return oauthError("invalid_client_metadata", "Client metadata is not valid")
    }
    const id = yield* newOAuthApplicationId
    const clientIdentifier = `wfo_client_${id}`
    const application = yield* store.upsertOAuthApplication({
      id,
      kind: "dcr",
      clientIdentifier,
      name: decoded.value.client_name,
      redirectUris: decoded.value.redirect_uris,
      metadata: metadataJson(decoded.value)
    })
    return json({
      ...decoded.value,
      client_id: application.clientIdentifier,
      client_id_issued_at: Math.floor(application.createdAt.getTime() / 1_000),
      token_endpoint_auth_method: "none"
    }, 201)
  })

  const authorize = (request: Request) => Effect.gen(function*() {
    if (resource === undefined || issuer === undefined) return oauthError("server_error", "OAuth is unavailable", 503)
    const query = new URL(request.url).searchParams
    const clientIdentifier = query.get("client_id")
    const redirectUri = query.get("redirect_uri")
    const requestedResource = query.get("resource")
    const challenge = query.get("code_challenge")
    const state = query.get("state")
    const scope = query.get("scope") ?? "mcp"
    if (query.get("response_type") !== "code") return oauthError("unsupported_response_type", "Only response_type=code is supported")
    if (clientIdentifier === null || redirectUri === null || challenge === null) return oauthError("invalid_request", "client_id, redirect_uri, and code_challenge are required")
    if (query.get("code_challenge_method") !== "S256") return oauthError("invalid_request", "PKCE with S256 is required")
    if (!validPkceValue(challenge)) return oauthError("invalid_request", "code_challenge is not valid")
    if (requestedResource !== resource) return oauthError("invalid_target", "The resource must identify this MCP server")
    if (scope !== "mcp") return oauthError("invalid_scope", "Only the mcp scope is supported")
    const applicationResult = yield* Effect.exit(applicationFor(clientIdentifier))
    if (Exit.isFailure(applicationResult) || applicationResult.value === undefined) {
      return oauthError("invalid_client", "The OAuth application could not be verified")
    }
    const application = applicationResult.value
    if (!application.redirectUris.includes(redirectUri)) return oauthError("invalid_request", "redirect_uri is not registered")
    const id = yield* newOAuthRequestId
    yield* store.createOAuthAuthorizationRequest({
      id,
      applicationId: application.id,
      redirectUri,
      state,
      codeChallenge: challenge,
      resource,
      scope: "mcp",
      expiresAt: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, Duration.minutes(10)))
    })
    return Response.redirect(`${issuer}/oauth/consent?request=${encodeURIComponent(id)}`, 302)
  })

  const consentView = (request: Request, id: string, context?: { readonly localSecret?: string }) => Effect.gen(function*() {
    const session = yield* currentSession(request, context)
    if (session === undefined) return json({ error: "Sign in to continue" }, 401)
    const pending = yield* store.getOAuthAuthorizationRequest(id)
    if (pending === undefined) return json({ error: "Authorization request is expired or already used" }, 410)
    const application = yield* store.findOAuthApplicationById(pending.applicationId)
    const clients = (yield* store.listClients(session.tenantId)).filter((client) => client.revokedAt === null)
    if (application === undefined) return json({ error: "OAuth application is no longer available" }, 410)
    return json({
      request: { id: pending.id, scope: pending.scope, resource: pending.resource },
      application: { id: application.id, kind: application.kind, name: application.name, clientIdentifier: application.clientIdentifier },
      clients
    })
  })

  const decideConsent = (request: Request, id: string, context?: { readonly localSecret?: string }) => Effect.gen(function*() {
    if (!sameOrigin(request)) return json({ error: "Cross-site requests are not permitted" }, 403)
    const session = yield* currentSession(request, context)
    if (session === undefined) return json({ error: "Sign in to continue" }, 401)
    const declared = Number(request.headers.get("content-length") ?? 0)
    if (declared > 64 * 1024) return json({ error: "Consent decision is too large" }, 413)
    const body = yield* Effect.promise(() => request.text())
    if (body.length > 64 * 1024) return json({ error: "Consent decision is too large" }, 413)
    const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(ConsentDecision))(body)
    if (Exit.isFailure(decoded)) return json({ error: "Invalid consent decision" }, 400)
    const pending = yield* store.getOAuthAuthorizationRequest(id)
    if (pending === undefined) return json({ error: "Authorization request is expired or already used" }, 410)
    const redirect = new URL(pending.redirectUri)
    if (pending.state !== null) redirect.searchParams.set("state", pending.state)
    redirect.searchParams.set("iss", issuer ?? "")
    if (decoded.value.decision === "deny") {
      if ((yield* store.consumeOAuthAuthorizationRequest(id)) === undefined) {
        return json({ error: "Authorization request is expired or already used" }, 410)
      }
      redirect.searchParams.set("error", "access_denied")
      return json({ redirect: redirect.toString() })
    }
    const client = yield* store.findClientById(session.tenantId, decoded.value.clientId)
    if (client === undefined || client.revokedAt !== null) return json({ error: "Gateway Client is not available" }, 400)
    if ((yield* store.consumeOAuthAuthorizationRequest(id)) === undefined) {
      return json({ error: "Authorization request is expired or already used" }, 410)
    }
    const grant = yield* store.findOrCreateOAuthGrant({
      id: yield* newOAuthGrantId,
      applicationId: pending.applicationId,
      subjectId: session.subjectId,
      tenantId: session.tenantId,
      clientId: client.id,
      resource: pending.resource,
      scope: pending.scope
    })
    const code = yield* newOAuthAuthorizationCode
    yield* store.createOAuthAuthorizationCode({
      hash: OAuthSecretHash.make(yield* sha256Hex(code)),
      grantId: grant.id,
      applicationId: grant.applicationId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      resource: pending.resource,
      scope: pending.scope,
      expiresAt: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, Duration.minutes(5)))
    })
    redirect.searchParams.set("code", code)
    return json({ redirect: redirect.toString() })
  })

  const issueInitialTokens = (code: string, verifier: string, clientIdentifier: string, redirectUri: string, requestedResource: string) => Effect.gen(function*() {
    if (!validPkceValue(verifier)) return undefined
    const application = yield* store.findOAuthApplication(clientIdentifier)
    if (application === undefined) return undefined
    const authorization = yield* store.consumeOAuthAuthorizationCode(OAuthSecretHash.make(yield* sha256Hex(code)))
    if (
      authorization === undefined || authorization.applicationId !== application.id ||
      authorization.redirectUri !== redirectUri || authorization.resource !== requestedResource ||
      (yield* sha256Base64Url(verifier)) !== authorization.codeChallenge
    ) return undefined
    const access = yield* newOAuthAccessToken
    const refresh = yield* newOAuthRefreshToken
    const familyId = yield* newOAuthTokenFamilyId
    const at = yield* DateTime.now
    yield* store.createOAuthTokens([
      {
        hash: OAuthSecretHash.make(yield* sha256Hex(access)), kind: "access", familyId,
        grantId: authorization.grantId, applicationId: authorization.applicationId,
        resource: authorization.resource, scope: authorization.scope,
        expiresAt: DateTime.toDateUtc(DateTime.addDuration(at, Duration.hours(1)))
      },
      {
        hash: OAuthSecretHash.make(yield* sha256Hex(refresh)), kind: "refresh", familyId,
        grantId: authorization.grantId, applicationId: authorization.applicationId,
        resource: authorization.resource, scope: authorization.scope,
        expiresAt: DateTime.toDateUtc(DateTime.addDuration(at, Duration.days(90)))
      }
    ])
    return { access, refresh }
  })

  const refreshTokens = (refreshToken: string, clientIdentifier: string, requestedResource: string) => Effect.gen(function*() {
    const application = yield* store.findOAuthApplication(clientIdentifier)
    if (application === undefined) return undefined
    const access = yield* newOAuthAccessToken
    const refresh = yield* newOAuthRefreshToken
    const at = yield* DateTime.now
    const rotated = yield* store.rotateOAuthRefreshToken({
      hash: OAuthSecretHash.make(yield* sha256Hex(refreshToken)),
      applicationId: application.id,
      resource: requestedResource,
      accessHash: OAuthSecretHash.make(yield* sha256Hex(access)),
      refreshHash: OAuthSecretHash.make(yield* sha256Hex(refresh)),
      accessExpiresAt: DateTime.toDateUtc(DateTime.addDuration(at, Duration.hours(1))),
      refreshExpiresAt: DateTime.toDateUtc(DateTime.addDuration(at, Duration.days(30)))
    })
    return rotated === undefined || rotated === "reused" ? undefined : { access, refresh }
  })

  const token = (request: Request) => Effect.gen(function*() {
    if (resource === undefined) return oauthError("server_error", "OAuth is unavailable", 503)
    const declared = Number(request.headers.get("content-length") ?? 0)
    if (declared > 64 * 1024) return oauthError("invalid_request", "Token request is too large", 413)
    const text = yield* Effect.promise(() => request.text())
    if (text.length > 64 * 1024) return oauthError("invalid_request", "Token request is too large", 413)
    const form = new URLSearchParams(text)
    const clientIdentifier = form.get("client_id")
    const requestedResource = form.get("resource")
    if (clientIdentifier === null || requestedResource !== resource) return oauthError("invalid_request", "client_id and the MCP resource are required")
    const grantType = form.get("grant_type")
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return oauthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported")
    }
    const issued = grantType === "authorization_code"
      ? yield* issueInitialTokens(
        form.get("code") ?? "",
        form.get("code_verifier") ?? "",
        clientIdentifier,
        form.get("redirect_uri") ?? "",
        requestedResource
      )
      : grantType === "refresh_token"
      ? yield* refreshTokens(form.get("refresh_token") ?? "", clientIdentifier, requestedResource)
      : undefined
    if (issued === undefined) return oauthError("invalid_grant", "The authorization grant is invalid or expired")
    return json({
      access_token: issued.access,
      token_type: "Bearer",
      expires_in: 3_600,
      refresh_token: issued.refresh,
      scope: "mcp"
    })
  })

  const grants = (request: Request, context?: { readonly localSecret?: string }) => Effect.gen(function*() {
    const session = yield* currentSession(request, context)
    if (session === undefined) return json({ error: "Sign in to continue" }, 401)
    return json(yield* store.listOAuthGrants(session.tenantId))
  })

  const revokeGrant = (request: Request, id: string, context?: { readonly localSecret?: string }) => Effect.gen(function*() {
    if (!sameOrigin(request)) return json({ error: "Cross-site requests are not permitted" }, 403)
    const session = yield* currentSession(request, context)
    if (session === undefined) return json({ error: "Sign in to continue" }, 401)
    return json({ revoked: yield* store.revokeOAuthGrant(session.tenantId, OAuthGrantId.make(id)) })
  })

  const run = <E>(effect: Effect.Effect<Response, E, HttpClient.HttpClient | Crypto.Crypto>): Promise<Response> =>
    runtime.runPromise(effect.pipe(Effect.catchCause(() => Effect.succeed(oauthError("server_error", "The authorization server could not complete the request", 500)))))

  return {
    enabled,
    resource,
    metadataUrl,
    challenge: (error) => metadataUrl === undefined ? "Bearer" : bearerChallenge(metadataUrl, error),
    authenticate: async (secret) => {
      if (!enabled || resource === undefined) return undefined
      return runtime.runPromise(store.resolveOAuthAccessToken({
        hash: OAuthSecretHash.make(await runtime.runPromise(sha256Hex(secret))),
        resource
      }))
    },
    handle: async (request, context) => {
      if (!enabled || issuer === undefined || resourceUrl === undefined) return undefined
      const url = new URL(request.url)
      if (request.method === "OPTIONS" && (url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/"))) {
        return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "content-type, authorization" } })
      }
      if (request.method === "GET" && (url.pathname === metadataUrl?.slice(resourceUrl.origin.length) || url.pathname === "/.well-known/oauth-protected-resource")) return protectedResourceMetadata()
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") return authorizationServerMetadata()
      if (request.method === "POST" && url.pathname === "/oauth/register") {
        if (!registrationAllowed(context?.remoteAddress)) {
          return json({ error: "rate_limited", error_description: "Too many client registrations" }, 429, { "retry-after": "60" })
        }
        return run(register(request))
      }
      if (request.method === "GET" && url.pathname === "/oauth/authorize") return run(authorize(request))
      if (request.method === "POST" && url.pathname === "/oauth/token") return run(token(request))
      if (request.method === "GET" && url.pathname === "/v1/oauth/authorization-request") return run(consentView(request, url.searchParams.get("id") ?? "", context))
      if (request.method === "POST" && url.pathname === "/v1/oauth/authorization-request") return run(decideConsent(request, url.searchParams.get("id") ?? "", context))
      if (request.method === "GET" && url.pathname === "/v1/oauth/grants") return run(grants(request, context))
      if (request.method === "DELETE" && url.pathname.startsWith("/v1/oauth/grants/")) return run(revokeGrant(request, decodeURIComponent(url.pathname.slice("/v1/oauth/grants/".length)), context))
      return undefined
    },
    dispose: () => runtime.dispose()
  }
}
