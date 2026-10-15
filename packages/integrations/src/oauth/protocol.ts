import { extractWWWAuthenticateParams } from "@modelcontextprotocol/client"
import { isJsonObject, parseJsonString, whenPresent, whenPresentFields, whenPresentMap } from "@integragents/contracts"
import type { Json, JsonObject } from "@integragents/contracts"
import { tracedFetch } from "@integragents/observability"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as oauth from "oauth4webapi"
import type { ClientAuthMethod } from "../catalog/store.ts"
import { DestinationRefused, Egress, gatewayUserAgent } from "../egress/egress.ts"
import type { FetchLike } from "../egress/egress.ts"
import { parseDestination } from "../egress/url-policy.ts"
import type { UrlPolicy } from "../egress/url-policy.ts"
import { OAuthError } from "../errors.ts"

type Stage = OAuthError["stage"]

const definitiveProviderErrors = new Map<string, OAuthError["reason"]>([
  ["invalid_grant", "invalid_grant"],
  ["invalid_client", "invalid_client"],
  ["unauthorized_client", "invalid_client"],
  ["invalid_scope", "invalid_scope"],
  ["access_denied", "denied"]
])

const reportedField = (message: string): string | undefined =>
  /^"response" body "([a-z_]+)" property/.exec(message)?.[1]

/** Maps a library or transport failure to what may be shown: codes, statuses, field names. */
export const protocolFailure =
  (stage: Stage) =>
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  (error: unknown): OAuthError => {
    if (error instanceof OAuthError) return error
    if (error instanceof DestinationRefused) {
      return new OAuthError({ stage, reason: "destination_blocked", detail: error.message })
    }
    if (error instanceof oauth.ResponseBodyError) {
      return new OAuthError({
        stage,
        reason: definitiveProviderErrors.get(error.error) ?? "request",
        detail: `the provider answered ${error.error} (HTTP ${error.status})`
      })
    }
    if (error instanceof oauth.AuthorizationResponseError) {
      return new OAuthError({
        stage,
        reason: definitiveProviderErrors.get(error.error) ?? "denied",
        detail: `the provider returned ${error.error}`
      })
    }
    if (error instanceof oauth.WWWAuthenticateChallengeError) {
      return new OAuthError({
        stage,
        reason: "request",
        detail: `the provider refused the request (HTTP ${error.status})`
      })
    }
    if (error instanceof oauth.UnsupportedOperationError) {
      return new OAuthError({
        stage,
        reason: "unsupported",
        detail: `the provider does not support this (${error.code})`
      })
    }
    if (error instanceof oauth.OperationProcessingError) {
      const field = reportedField(error.message)
      return new OAuthError({
        stage,
        reason: "invalid_response",
        detail:
          field === undefined
            ? `the provider's response was not valid (${error.code})`
            : `the provider's response has an invalid "${field}" (${error.code})`
      })
    }
    if (error instanceof TypeError) {
      return new OAuthError({ stage, reason: "request", detail: "the provider could not be reached" })
    }
    return new OAuthError({ stage, reason: "request", detail: "the request to the provider failed" })
  }

const requestTimeout = "30 seconds"

/** The library's fetch hook: every request through egress, traced, with the gateway's User-Agent. */
const transport = (fetch: FetchLike, context: Parameters<typeof tracedFetch>[0]) => {
  const traced = tracedFetch(context, fetch)
  return (url: string, init: oauth.CustomFetchOptions<string, BodyInit | undefined>): Promise<Response> => {
    const headers = new Headers(init.headers)
    if (!headers.has("user-agent")) headers.set("user-agent", gatewayUserAgent)
    return traced(url, {
      method: init.method,
      headers,
      ...whenPresent("body", init.body),
      ...whenPresent("signal", init.signal),
      redirect: "manual"
    })
  }
}

type RequestSettings = {
  readonly [oauth.customFetch]: ReturnType<typeof transport>
  readonly [oauth.allowInsecureRequests]: true
  readonly signal: AbortSignal
}

const withNormalizedResponse = (response: Response, rewrite: (body: JsonObject) => JsonObject): Promise<Response> =>
  response
    .clone()
    .text()
    .then((text) => {
      const parsed = parseJsonString(text)
      if (Option.isNone(parsed) || !isJsonObject(parsed.value)) return response
      return new Response(JSON.stringify(rewrite(parsed.value)), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    })

const SlackGrant = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  token_type: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String)
})
const decodeSlackEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({
    ...SlackGrant.fields,
    ok: Schema.Literal(true),
    authed_user: Schema.optional(SlackGrant)
  })
)

/**
 * Slack answers with `token_type: "bot" | "user"`, which names the account,
 * not an HTTP scheme, and may put a user-only grant under `authed_user`.
 * Everything else passes through, minus an ID token nobody asked to validate.
 */
const tokenBody =
  (keepIdToken: boolean) =>
  (body: JsonObject): JsonObject => {
    const { id_token: _idToken, ...withoutIdToken } = body
    const base: JsonObject = keepIdToken ? body : withoutIdToken
    const envelope = decodeSlackEnvelope(body)
    if (Option.isNone(envelope)) return base
    const user = envelope.value.authed_user
    const grant =
      user?.access_token !== undefined &&
      (envelope.value.access_token === undefined || envelope.value.scope?.trim() === "")
        ? user
        : envelope.value
    if (grant.access_token === undefined || (grant.token_type !== "bot" && grant.token_type !== "user")) return base
    const scope = grant.scope
      ?.split(/[\s,]+/)
      .filter((entry) => entry.length > 0)
      .join(" ")
    return {
      access_token: grant.access_token,
      token_type: "Bearer",
      ...whenPresent("refresh_token", grant.refresh_token),
      ...whenPresent("expires_in", grant.expires_in),
      ...whenPresent("scope", scope === "" ? undefined : scope)
    }
  }

/** A secret registered without `client_secret_expires_at` never expires, which RFC 7591 spells as 0. */
const registrationBody = (body: JsonObject): JsonObject =>
  body["client_secret"] !== undefined && body["client_secret_expires_at"] === undefined
    ? { ...body, client_secret_expires_at: 0 }
    : body

const ProtectedResource = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.optional(Schema.Array(Schema.String)),
  scopes_supported: Schema.optional(Schema.Array(Schema.String))
})

const RegisteredClient = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optional(Schema.String),
  client_secret_expires_at: Schema.optional(Schema.Number),
  token_endpoint_auth_method: Schema.optional(Schema.String)
})

export interface Challenge {
  readonly resourceMetadata: URL | undefined
  readonly scopes: ReadonlyArray<string> | undefined
}

export interface RegisteredClient {
  readonly clientId: string
  readonly clientSecret: string | undefined
  readonly secretExpiresAt: number | undefined
  readonly tokenAuthMethod: ClientAuthMethod
}

export interface ClientCredentials {
  readonly clientId: string
  readonly clientSecret: string | undefined
  readonly tokenAuthMethod: ClientAuthMethod
}

export type TokenResponse = oauth.TokenEndpointResponse

const clientOf = (credentials: ClientCredentials): oauth.Client => ({
  client_id: credentials.clientId,
  token_endpoint_auth_method: credentials.tokenAuthMethod
})

const clientAuthOf = (credentials: ClientCredentials): oauth.ClientAuth => {
  const secret = credentials.clientSecret ?? ""
  switch (credentials.tokenAuthMethod) {
    case "none":
      return oauth.None()
    case "client_secret_basic":
      return oauth.ClientSecretBasic(secret)
    case "client_secret_post":
      return oauth.ClientSecretPost(secret)
  }
}

/** RFC 8414 or OIDC well-known URL → the issuer it describes. */
const issuerOfWellKnown = (url: URL): URL | undefined => {
  const oidc = "/.well-known/openid-configuration"
  if (url.pathname.endsWith(oidc)) {
    return new URL(`${url.origin}${url.pathname.slice(0, -oidc.length)}`)
  }
  const rfc8414 = "/.well-known/oauth-authorization-server"
  if (url.pathname.startsWith(rfc8414)) {
    return new URL(`${url.origin}${url.pathname.slice(rfc8414.length)}`)
  }
  return undefined
}

const scopeBudget = 8 * 1024

/** Servers that advertise hundreds of scopes still need a request URL that fits. */
export const boundScopes = (scopes: ReadonlyArray<string>): ReadonlyArray<string> => {
  const kept: Array<string> = []
  let length = 0
  for (const scope of scopes) {
    const next = length + (kept.length === 0 ? 0 : 1) + scope.length
    if (next > scopeBudget) break
    kept.push(scope)
    length = next
  }
  return kept
}

/**
 * The client authentication to register or use: none when the server allows
 * public clients, post when that is all it lists, otherwise basic, the
 * RFC 6749 default.
 */
export const preferredAuthMethod = (server: oauth.AuthorizationServer): ClientAuthMethod => {
  const supported = server.token_endpoint_auth_methods_supported
  if (supported?.includes("none") === true) return "none"
  if (supported?.includes("client_secret_post") === true && !supported.includes("client_secret_basic")) {
    return "client_secret_post"
  }
  return "client_secret_basic"
}

/** For a client someone created by hand: their secret decides between public and confidential. */
export const suppliedAuthMethod = (server: oauth.AuthorizationServer, hasSecret: boolean): ClientAuthMethod => {
  if (!hasSecret) return "none"
  const supported = server.token_endpoint_auth_methods_supported
  return supported?.includes("client_secret_basic") === true && !supported.includes("client_secret_post")
    ? "client_secret_basic"
    : "client_secret_post"
}

/** Authorize-URL parameters some providers need for a refresh token, keyed by authorization host. */
const providerAuthorizeExtras = new Map<string, ReadonlyArray<readonly [string, string]>>([
  [
    "accounts.google.com",
    [
      ["access_type", "offline"],
      ["prompt", "consent"]
    ]
  ],
  ["www.dropbox.com", [["token_access_type", "offline"]]]
])

const makeProtocol = (egress: { readonly policy: UrlPolicy; readonly fetch: FetchLike }) => {
  const request = <A>(stage: Stage, run: (settings: RequestSettings) => Promise<A>) =>
    Effect.flatMap(Effect.context<never>(), (context) =>
      Effect.tryPromise({
        try: (signal) =>
          run({
            [oauth.customFetch]: transport(egress.fetch, context),
            [oauth.allowInsecureRequests]: true,
            signal
          }),
        catch: protocolFailure(stage)
      })
    ).pipe(
      Effect.timeoutOrElse({
        duration: requestTimeout,
        orElse: () =>
          Effect.fail(new OAuthError({ stage, reason: "timeout", detail: "the provider did not answer in time" }))
      })
    )

  const destination = (stage: Stage, value: string) => {
    const url = parseDestination(value, egress.policy)
    return url === undefined
      ? Effect.fail(
          new OAuthError({
            stage,
            reason: "destination_blocked",
            detail: `${URL.parse(value)?.hostname ?? "The URL"} is not a destination this gateway may reach`
          })
        )
      : Effect.succeed(url)
  }

  const headersOnly = (url: URL, init: RequestInit) =>
    Effect.promise((signal) =>
      egress
        .fetch(url, {
          ...init,
          signal,
          redirect: "manual",
          headers: { "user-agent": gatewayUserAgent, accept: "application/json, text/event-stream", ...init.headers }
        })
        .then(
          async (response) => {
            await response.body?.cancel()
            return Option.some(response)
          },
          () => Option.none<Response>()
        )
    ).pipe(Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(Option.none<Response>()) }))

  const challengeOf = (response: Response): Challenge => {
    if (response.status !== 401 && response.status !== 403) return { resourceMetadata: undefined, scopes: undefined }
    const params = extractWWWAuthenticateParams(response)
    return {
      resourceMetadata: params.resourceMetadataUrl,
      scopes: params.scope?.split(" ").filter((scope) => scope.length > 0)
    }
  }

  /**
   * Reads the protected endpoint's Bearer challenge from headers alone: a GET
   * first, since a successful MCP GET may open an endless stream, then an MCP
   * `initialize` for servers that only challenge POSTs. A session that probe
   * opens is deleted again.
   */
  const challenge = (endpoint: URL) =>
    Effect.gen(function* () {
      const get = yield* headersOnly(endpoint, { method: "GET" })
      if (Option.isNone(get)) return { resourceMetadata: undefined, scopes: undefined }
      const fromGet = challengeOf(get.value)
      if (fromGet.resourceMetadata !== undefined || ![401, 403, 405].includes(get.value.status)) return fromGet
      const post = yield* headersOnly(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: gatewayUserAgent, version: "1.0.0" }
          }
        })
      })
      if (Option.isNone(post)) return fromGet
      const session = post.value.headers.get("mcp-session-id")
      if (post.value.ok && session !== null) {
        yield* headersOnly(endpoint, {
          method: "DELETE",
          headers: { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" }
        }).pipe(Effect.timeout("1 second"), Effect.ignore)
      }
      const fromPost = challengeOf(post.value)
      return fromPost.resourceMetadata === undefined && fromPost.scopes === undefined ? fromGet : fromPost
    })

  const metadataDocument = (stage: Stage, url: URL) =>
    request(stage, (settings) =>
      settings[oauth.customFetch](url.href, {
        method: "GET",
        body: undefined,
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: settings.signal
      })
    )

  const readJson = (stage: Stage, response: Response) =>
    Effect.tryPromise({
      try: () => response.json().then((value: Json) => value),
      catch: () => new OAuthError({ stage, reason: "invalid_response", detail: "the metadata was not JSON" })
    })

  /**
   * RFC 9728 metadata for `endpoint`: the challenge's advertised document,
   * else the path-scoped and then origin-scoped well-known locations. A
   * resource may cover the endpoint from a parent path on the same origin,
   * never a sibling service or another host.
   */
  const protectedResource = (endpoint: URL, advertised: URL | undefined) =>
    Effect.gen(function* () {
      const candidates =
        advertised !== undefined
          ? [yield* destination("discover", advertised.href)]
          : [
              new URL(
                `/.well-known/oauth-protected-resource${endpoint.pathname === "/" ? "" : endpoint.pathname}`,
                endpoint
              ),
              ...(endpoint.pathname === "/" ? [] : [new URL("/.well-known/oauth-protected-resource", endpoint)])
            ]
      for (const candidate of candidates) {
        const response = yield* metadataDocument("discover", candidate)
        if (response.status === 404 && advertised === undefined) continue
        if (!response.ok) {
          return yield* new OAuthError({
            stage: "discover",
            reason: response.status === 404 ? "metadata_missing" : "request",
            detail: `the protected resource metadata answered HTTP ${response.status}`
          })
        }
        const found = yield* readJson("discover", response).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ProtectedResource)),
          Effect.mapError(
            () =>
              new OAuthError({
                stage: "discover",
                reason: "invalid_response",
                detail: "the protected resource metadata is not valid"
              })
          )
        )
        const resource = yield* destination("discover", found.resource)
        const prefix = resource.pathname.endsWith("/") ? resource.pathname : `${resource.pathname}/`
        if (
          resource.origin !== endpoint.origin ||
          (resource.pathname !== endpoint.pathname && !endpoint.pathname.startsWith(prefix))
        ) {
          return yield* new OAuthError({
            stage: "discover",
            reason: "invalid_response",
            detail: `the protected resource metadata names ${resource.href}, which does not cover ${endpoint.href}`
          })
        }
        return Option.some(found)
      }
      return Option.none<typeof ProtectedResource.Type>()
    })

  const processedServer = (issuer: URL, response: Response) =>
    request("discover", () => oauth.processDiscoveryResponse(issuer, response))

  /** Authorization server metadata for `issuer`, RFC 8414 first and OIDC discovery second. */
  const authorizationServer = (issuer: URL) =>
    Effect.gen(function* () {
      const oauth2 = yield* request("discover", (settings) =>
        oauth.discoveryRequest(issuer, { ...settings, algorithm: "oauth2" })
      )
      if (oauth2.status !== 404) return yield* processedServer(issuer, oauth2)
      const oidc = yield* request("discover", (settings) =>
        oauth.discoveryRequest(issuer, { ...settings, algorithm: "oidc" })
      )
      if (oidc.status === 404) {
        return yield* new OAuthError({
          stage: "discover",
          reason: "metadata_missing",
          detail: `${issuer.href} publishes no authorization server metadata`
        })
      }
      return yield* processedServer(issuer, oidc)
    })

  const checkServerEndpoints = (server: oauth.AuthorizationServer) =>
    Effect.forEach(
      [server.authorization_endpoint, server.token_endpoint, server.registration_endpoint].filter(
        (address) => address !== undefined
      ),
      (address) => destination("discover", address),
      { discard: true }
    )

  return {
    destination,

    /** The endpoint's protected resource metadata and challenge, when it publishes them. */
    discoverResource: (endpoint: URL) =>
      Effect.gen(function* () {
        const advertised = yield* challenge(endpoint)
        const resource = yield* protectedResource(endpoint, advertised.resourceMetadata)
        return { challenge: advertised, resource }
      }),

    /**
     * The authorization server behind `discoveryUrl`: a well-known metadata
     * URL is read as is; anything else is a protected resource whose metadata
     * names its server, or, for servers predating RFC 9728, its own issuer.
     */
    discoverServer: (discoveryUrl: string) =>
      Effect.gen(function* () {
        const endpoint = yield* destination("discover", discoveryUrl)
        const wellKnownIssuer = issuerOfWellKnown(endpoint)
        if (wellKnownIssuer !== undefined) {
          const response = yield* metadataDocument("discover", endpoint)
          const server = yield* processedServer(wellKnownIssuer, response)
          yield* checkServerEndpoints(server)
          return { server, resource: Option.none<typeof ProtectedResource.Type>(), challenge: Option.none<Challenge>() }
        }
        const advertised = yield* challenge(endpoint)
        const resource = yield* protectedResource(endpoint, advertised.resourceMetadata)
        const issuers = Option.match(resource, {
          onSome: (found) => found.authorization_servers?.slice(0, 1) ?? [],
          onNone: () => (endpoint.pathname === "/" ? [endpoint.href] : [endpoint.href, endpoint.origin])
        })
        if (issuers.length === 0) {
          return yield* new OAuthError({
            stage: "discover",
            reason: "invalid_response",
            detail: "the protected resource metadata names no authorization server"
          })
        }
        let last = new OAuthError({
          stage: "discover",
          reason: "metadata_missing",
          detail: "no authorization server found"
        })
        for (const issuer of issuers) {
          const found = yield* Effect.result(destination("discover", issuer).pipe(Effect.flatMap(authorizationServer)))
          if (found._tag === "Success") {
            yield* checkServerEndpoints(found.success)
            return { server: found.success, resource, challenge: Option.some(advertised) }
          }
          last = found.failure
          if (Option.isSome(resource)) break
        }
        return yield* last
      }),

    register: (input: {
      readonly server: oauth.AuthorizationServer
      readonly redirectUri: string
      readonly scopes: ReadonlyArray<string>
      readonly tokenAuthMethod: ClientAuthMethod
    }) =>
      Effect.gen(function* () {
        const registered = yield* request("register", async (settings) => {
          const response = await oauth.dynamicClientRegistrationRequest(
            input.server,
            {
              client_name: "integrations gateway",
              redirect_uris: [input.redirectUri],
              token_endpoint_auth_method: input.tokenAuthMethod,
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              ...whenPresent("scope", input.scopes.length === 0 ? undefined : input.scopes.join(" "))
            },
            settings
          )
          const normalized = await withNormalizedResponse(response, registrationBody)
          return oauth.processDynamicClientRegistrationResponse(
            normalized.status === 200
              ? new Response(normalized.body, { status: 201, headers: normalized.headers })
              : normalized
          )
        })
        const decoded = yield* Schema.decodeUnknownEffect(RegisteredClient)(registered).pipe(
          Effect.mapError(
            () =>
              new OAuthError({
                stage: "register",
                reason: "invalid_response",
                detail: "the registration response is not valid"
              })
          )
        )
        if (
          decoded.token_endpoint_auth_method !== undefined &&
          decoded.token_endpoint_auth_method !== input.tokenAuthMethod
        ) {
          return yield* new OAuthError({
            stage: "register",
            reason: "invalid_response",
            detail: `the provider registered ${decoded.token_endpoint_auth_method} instead of ${input.tokenAuthMethod}`
          })
        }
        return {
          clientId: decoded.client_id,
          clientSecret: decoded.client_secret,
          secretExpiresAt:
            decoded.client_secret_expires_at === undefined || decoded.client_secret_expires_at === 0
              ? undefined
              : decoded.client_secret_expires_at * 1000,
          tokenAuthMethod: input.tokenAuthMethod
        } satisfies RegisteredClient
      }).pipe(Effect.withSpan("OAuth.register")),

    authorizationRequest: (input: {
      readonly server: oauth.AuthorizationServer
      readonly client: ClientCredentials
      readonly redirectUri: string
      readonly scopes: ReadonlyArray<string>
      readonly resource: string | undefined
      readonly withNonce: boolean
    }) =>
      Effect.gen(function* () {
        const endpoint = input.server.authorization_endpoint
        if (endpoint === undefined) {
          return yield* new OAuthError({
            stage: "start",
            reason: "unsupported",
            detail: "the provider has no authorization endpoint"
          })
        }
        const state = oauth.generateRandomState()
        const codeVerifier = oauth.generateRandomCodeVerifier()
        const nonce = input.withNonce ? oauth.generateRandomNonce() : undefined
        const codeChallenge = yield* request("start", () => oauth.calculatePKCECodeChallenge(codeVerifier))
        const url = new URL(endpoint)
        url.searchParams.set("response_type", "code")
        url.searchParams.set("client_id", input.client.clientId)
        url.searchParams.set("redirect_uri", input.redirectUri)
        url.searchParams.set("state", state)
        url.searchParams.set("code_challenge", codeChallenge)
        url.searchParams.set("code_challenge_method", "S256")
        if (input.scopes.length > 0) url.searchParams.set("scope", input.scopes.join(" "))
        if (input.resource !== undefined) url.searchParams.set("resource", input.resource)
        if (nonce !== undefined) url.searchParams.set("nonce", nonce)
        for (const [name, value] of providerAuthorizeExtras.get(url.host) ?? []) {
          url.searchParams.set(name, value)
        }
        return { authorizationUrl: url.href, state, codeVerifier, nonce }
      }),

    exchange: (input: {
      readonly server: oauth.AuthorizationServer
      readonly client: ClientCredentials
      readonly callback: URL
      readonly state: string
      readonly redirectUri: string
      readonly codeVerifier: string
      readonly resource: string | undefined
      readonly nonce: string | undefined
    }) =>
      request("complete", async (settings) => {
        const client = clientOf(input.client)
        const parameters = oauth.validateAuthResponse(input.server, client, input.callback, input.state)
        const response = await oauth.authorizationCodeGrantRequest(
          input.server,
          client,
          clientAuthOf(input.client),
          parameters,
          input.redirectUri,
          input.codeVerifier,
          {
            ...settings,
            ...whenPresentMap("additionalParameters", input.resource, (resource) => ({ resource }))
          }
        )
        return oauth.processAuthorizationCodeResponse(
          input.server,
          client,
          await withNormalizedResponse(response, tokenBody(input.nonce !== undefined)),
          whenPresentFields(input.nonce, (expectedNonce) => ({ expectedNonce, requireIdToken: true }))
        )
      }).pipe(Effect.withSpan("OAuth.exchange")),

    refresh: (input: {
      readonly server: oauth.AuthorizationServer
      readonly client: ClientCredentials
      readonly refreshToken: string
      readonly resource: string | undefined
    }) =>
      request("refresh", async (settings) => {
        const client = clientOf(input.client)
        const response = await oauth.refreshTokenGrantRequest(
          input.server,
          client,
          clientAuthOf(input.client),
          input.refreshToken,
          {
            ...settings,
            ...whenPresentMap("additionalParameters", input.resource, (resource) => ({ resource }))
          }
        )
        return oauth.processRefreshTokenResponse(
          input.server,
          client,
          await withNormalizedResponse(response, tokenBody(false))
        )
      }).pipe(Effect.withSpan("OAuth.refresh"))
  }
}

export type Protocol = ReturnType<typeof makeProtocol>

/** The OAuth wire protocol over this process's egress. */
export class OAuthProtocol extends Context.Service<OAuthProtocol, Protocol>()("@integragents/host/OAuthProtocol") {
  static readonly layer: Layer.Layer<OAuthProtocol, never, Egress> = Layer.effect(
    OAuthProtocol,
    Effect.gen(function* () {
      return makeProtocol(yield* Egress)
    })
  )
}
