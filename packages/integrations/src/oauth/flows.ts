import { randomBytes } from "node:crypto"
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization
} from "@modelcontextprotocol/sdk/client/auth.js"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { CatalogStore } from "../catalog/store.ts"
import type { OAuthClientRecord } from "../catalog/store.ts"
import {
  connectionCredentialKey,
  CredentialStore,
  oauthClientCredentialKey,
  readTokens,
  writeTokens
} from "../storage/credentials.ts"
import type { StoredTokens } from "../storage/credentials.ts"
import { describeCause, OAuthError, StorageError } from "../errors.ts"
import { OAuthClientSlug, OAuthState } from "../catalog/ids.ts"
import { connectionAddress, ConnectionName, IntegrationSlug } from "@mokronos/contracts"
import { AuthTemplateSlug } from "../catalog/ids.ts"
import { whenPresent } from "@mokronos/contracts"
import { OAuthServerProbe, OwnerTier } from "@mokronos/contracts"

/** OAuth, over the flow primitives in `@modelcontextprotocol/sdk/client/auth`.
 *
 *  Those functions are standalone — metadata discovery (RFC 8414 and RFC 9728),
 *  dynamic client registration (RFC 7591), PKCE authorization, code exchange and
 *  refresh — so they serve an OpenAPI integration just as well as an MCP one.
 *  What is left to own is where the client, the pending flow and the resulting
 *  tokens are kept, and the decision to refresh a token before a call rather
 *  than after a failure. */

/** The metadata this host needs, decoded out of whatever the server published.
 *  Discovery returns a large document; only these fields drive a flow. */
const ServerMetadata = Schema.Struct({
  issuer: Schema.optional(Schema.String),
  authorization_endpoint: Schema.optional(Schema.String),
  token_endpoint: Schema.optional(Schema.String),
  registration_endpoint: Schema.optional(Schema.String),
  scopes_supported: Schema.optional(Schema.Array(Schema.String)),
  token_endpoint_auth_methods_supported: Schema.optional(Schema.Array(Schema.String))
})
type ServerMetadata = typeof ServerMetadata.Type

const decodeServerMetadata = Schema.decodeUnknownEffect(ServerMetadata)

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String)
})

const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse)

const RegisteredClient = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optional(Schema.String)
})

const decodeRegisteredClient = Schema.decodeUnknownEffect(RegisteredClient)

/** Discovers an authorization server starting from a resource URL.
 *
 *  RFC 9728 first: the resource says which authorization servers speak for it.
 *  Falling back to treating the URL itself as the issuer covers the many
 *  providers that publish RFC 8414 metadata and no resource metadata. */
const discover = (
  url: string
): Effect.Effect<{
  readonly metadata: ServerMetadata
  readonly resource: Option.Option<string>
}, OAuthError> =>
  Effect.tryPromise({
    try: async () => {
      const resource = await discoverOAuthProtectedResourceMetadata(url).catch(() => undefined)
      const authorizationServer = resource?.authorization_servers?.[0] ?? url
      const metadata = await discoverAuthorizationServerMetadata(authorizationServer)
      if (metadata === undefined) {
        throw new Error(`No authorization server metadata at ${authorizationServer}`)
      }
      return { metadata, resource: resource?.resource }
    },
    catch: (cause) => new OAuthError({
      stage: "probe",
      detail: describeCause(cause),
      cause
    })
  }).pipe(
    Effect.flatMap((found) =>
      decodeServerMetadata(found.metadata).pipe(
        Effect.mapError((cause) =>
          new OAuthError({
            stage: "probe",
            detail: "Authorization server metadata was unreadable",
            cause
          })
        ),
        Effect.map((metadata) => ({
          metadata,
          resource: Option.fromNullishOr(found.resource)
        }))
      )
    )
  )

/** RFC 8707 wants the resource as a URL; the catalog stores it as text. */
const resourceUrl = (resource: string | undefined): URL | undefined =>
  resource === undefined ? undefined : new URL(resource)

/** The client metadata this host presents when registering itself. */
const clientMetadata = (redirectUri: string, scopes: ReadonlyArray<string>) => ({
  client_name: "integrations gateway",
  redirect_uris: [redirectUri],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "client_secret_post",
  ...whenPresent("scope", scopes.length === 0 ? undefined : scopes.join(" "))
})

/** Empty because the SDK's flow functions read the redirect from their own
 *  argument rather than from the client record. */
const noRedirectUris: ReadonlyArray<string> = []

/** How the SDK's flow functions want a client described. */
const clientInformation = (
  record: OAuthClientRecord,
  secret: Option.Option<string>
) => ({
  client_id: record.clientId,
  ...whenPresent("client_secret", Option.getOrUndefined(secret)),
  redirect_uris: noRedirectUris
})

const metadataOf = (record: OAuthClientRecord) => ({
  issuer: record.issuer ?? record.authorizationUrl,
  authorization_endpoint: record.authorizationUrl,
  token_endpoint: record.tokenUrl,
  response_types_supported: ["code"],
  ...whenPresent(
    "token_endpoint_auth_methods_supported",
    record.tokenAuthMethods.length === 0 ? undefined : [...record.tokenAuthMethods]
  )
})

export interface StartOptions {
  readonly owner: OwnerTier
  readonly clientOwner: OwnerTier
  readonly client: OAuthClientSlug
  readonly integration: IntegrationSlug
  readonly connection: ConnectionName
  readonly template: AuthTemplateSlug
  readonly redirectUri: string
}

export interface CompletedAuthorization {
  readonly owner: OwnerTier
  readonly integration: IntegrationSlug
  readonly connection: ConnectionName
  readonly template: AuthTemplateSlug
  readonly clientOwner: OwnerTier
  readonly client: OAuthClientSlug
  readonly scope: Option.Option<string>
  readonly expiresAt: Option.Option<number>
}

export interface OAuthAccess {
  readonly value: string
  readonly expiresAt?: number
}

export class OAuthFlows extends Context.Service<
  OAuthFlows,
  {
    /** Reads an authorization server's metadata. Changes no stored state. */
    readonly probe: (url: string) => Effect.Effect<OAuthServerProbe, OAuthError>
    /** Registers this host as a client with the server (RFC 7591). */
    readonly registerDynamicClient: (options: {
      readonly owner: OwnerTier
      readonly slug: OAuthClientSlug
      readonly integration: IntegrationSlug
      readonly redirectUri: string
      readonly registrationEndpoint: string
      readonly authorizationUrl: string
      readonly tokenUrl: string
      readonly issuer?: string
      readonly resource?: string
      readonly scopes: ReadonlyArray<string>
      readonly tokenAuthMethods?: ReadonlyArray<string>
    }) => Effect.Effect<OAuthClientSlug, OAuthError | StorageError>
    /** Records a client an operator registered by hand. */
    readonly createClient: (options: {
      readonly owner: OwnerTier
      readonly slug: OAuthClientSlug
      readonly integration: IntegrationSlug
      readonly authorizationUrl: string
      readonly tokenUrl: string
      readonly clientId: string
      readonly clientSecret?: string
      readonly resource?: string
      readonly scopes?: ReadonlyArray<string>
    }) => Effect.Effect<OAuthClientSlug, StorageError>
    /** Begins an authorization, persisting the PKCE verifier against a
     *  single-use state value. */
    readonly start: (
      options: StartOptions
    ) => Effect.Effect<
      { readonly authorizationUrl: string; readonly state: OAuthState },
      OAuthError | StorageError
    >
    /** Exchanges a callback code for tokens and seals them. */
    readonly complete: (options: {
      readonly state: OAuthState
      readonly code: string
    }) => Effect.Effect<CompletedAuthorization, OAuthError | StorageError>
    /** The access token to send for a connection, refreshed first when it is
     *  spent. Returns `None` when the connection holds no OAuth grant. */
    readonly accessToken: (reference: {
      readonly owner: OwnerTier
      readonly integration: IntegrationSlug
      readonly connection: ConnectionName
      readonly clientOwner: OwnerTier
      readonly client: OAuthClientSlug
    }) => Effect.Effect<Option.Option<OAuthAccess>, OAuthError | StorageError>
  }
>()("@mokronos/integrations/OAuthFlows") {
  static readonly layer: Layer.Layer<
    OAuthFlows,
    never,
    CatalogStore | CredentialStore
  > = Layer.effect(
    OAuthFlows,
    Effect.gen(function* () {
      const store = yield* CatalogStore
      const credentials = yield* CredentialStore

      /** A registered client's secret lives beside the tenant's tokens, never
       *  in the catalog row. */
      const clientSecret = (record: OAuthClientRecord) =>
        credentials.get(oauthClientCredentialKey(record.owner, record.slug))

      const requireClient = Effect.fn("OAuthFlows.requireClient")(function* (reference: {
        readonly owner: OwnerTier
        readonly slug: OAuthClientSlug
      }) {
        const found = yield* store.findOAuthClient(reference)
        return yield* Option.match(found, {
          onNone: () => Effect.fail(new OAuthError({
            stage: "start",
            detail: `No OAuth client ${reference.owner}/${reference.slug}`
          })),
          onSome: Effect.succeed
        })
      })

      const probe = Effect.fn("OAuthFlows.probe")(function* (url: string) {
        const found = yield* discover(url)
        const metadata = found.metadata
        const authorizationUrl = metadata.authorization_endpoint
        const tokenUrl = metadata.token_endpoint
        if (authorizationUrl === undefined || tokenUrl === undefined) {
          return yield* new OAuthError({
            stage: "probe",
            detail: `${url} publishes no authorization or token endpoint`
          })
        }
        return yield* Schema.decodeUnknownEffect(OAuthServerProbe)({
          issuer: metadata.issuer ?? null,
          authorizationUrl,
          tokenUrl,
          resource: Option.getOrNull(found.resource),
          scopesSupported: metadata.scopes_supported ?? [],
          registrationEndpoint: metadata.registration_endpoint ?? null,
          tokenEndpointAuthMethodsSupported:
            metadata.token_endpoint_auth_methods_supported ?? [],
          clientIdMetadataDocumentSupported: false
        }).pipe(Effect.mapError((cause) =>
          new OAuthError({ stage: "probe", detail: "Could not describe the probe", cause })
        ))
      })

      const registerDynamicClient = Effect.fn("OAuthFlows.registerDynamicClient")(
        function* (options: {
          readonly owner: OwnerTier
          readonly slug: OAuthClientSlug
          readonly integration: IntegrationSlug
          readonly redirectUri: string
          readonly registrationEndpoint: string
          readonly authorizationUrl: string
          readonly tokenUrl: string
          readonly issuer?: string
          readonly resource?: string
          readonly scopes: ReadonlyArray<string>
          readonly tokenAuthMethods?: ReadonlyArray<string>
        }) {
          const registered = yield* Effect.tryPromise({
            try: () => registerClient(options.authorizationUrl, {
              metadata: {
                issuer: options.issuer ?? options.authorizationUrl,
                authorization_endpoint: options.authorizationUrl,
                token_endpoint: options.tokenUrl,
                registration_endpoint: options.registrationEndpoint,
                response_types_supported: ["code"]
              },
              clientMetadata: clientMetadata(options.redirectUri, options.scopes),
              ...whenPresent(
                "scope",
                options.scopes.length === 0 ? undefined : options.scopes.join(" ")
              )
            }),
            catch: (cause) => new OAuthError({
              stage: "register",
              detail: describeCause(cause),
              cause
            })
          })

          const decoded = yield* decodeRegisteredClient(registered).pipe(
            Effect.mapError((cause) =>
              new OAuthError({
                stage: "register",
                detail: "The server's registration response was unreadable",
                cause
              })
            )
          )

          const now = yield* Clock.currentTimeMillis
          yield* store.putOAuthClient({
            owner: options.owner,
            slug: options.slug,
            integration: options.integration,
            clientId: decoded.client_id,
            authorizationUrl: options.authorizationUrl,
            tokenUrl: options.tokenUrl,
            registrationEndpoint: options.registrationEndpoint,
            ...whenPresent("issuer", options.issuer),
            ...whenPresent("resource", options.resource),
            scopes: options.scopes,
            tokenAuthMethods: options.tokenAuthMethods ?? []
          })
          if (decoded.client_secret !== undefined) {
            yield* credentials.set(
              oauthClientCredentialKey(options.owner, options.slug),
              decoded.client_secret
            )
          }
          yield* Effect.annotateCurrentSpan("registeredAt", now)
          return options.slug
        }
      )

      const createClient = Effect.fn("OAuthFlows.createClient")(function* (options: {
        readonly owner: OwnerTier
        readonly slug: OAuthClientSlug
        readonly integration: IntegrationSlug
        readonly authorizationUrl: string
        readonly tokenUrl: string
        readonly clientId: string
        readonly clientSecret?: string
        readonly resource?: string
        readonly scopes?: ReadonlyArray<string>
      }) {
        yield* store.putOAuthClient({
          owner: options.owner,
          slug: options.slug,
          integration: options.integration,
          clientId: options.clientId,
          authorizationUrl: options.authorizationUrl,
          tokenUrl: options.tokenUrl,
          ...whenPresent("resource", options.resource),
          scopes: options.scopes ?? [],
          tokenAuthMethods: []
        })
        if (options.clientSecret !== undefined && options.clientSecret.length > 0) {
          yield* credentials.set(
            oauthClientCredentialKey(options.owner, options.slug),
            options.clientSecret
          )
        }
        return options.slug
      })

      const start = Effect.fn("OAuthFlows.start")(function* (options: StartOptions) {
        const client = yield* requireClient({
          owner: options.clientOwner,
          slug: options.client
        })
        const secret = yield* clientSecret(client)
        const state = OAuthState.make(randomBytes(32).toString("base64url"))

        const began = yield* Effect.tryPromise({
          try: () => startAuthorization(client.authorizationUrl, {
            metadata: metadataOf(client),
            clientInformation: clientInformation(client, secret),
            redirectUrl: options.redirectUri,
            state,
            ...whenPresent(
              "scope",
              client.scopes.length === 0 ? undefined : client.scopes.join(" ")
            ),
            ...whenPresent("resource", resourceUrl(client.resource))
          }),
          catch: (cause) => new OAuthError({
            stage: "start",
            detail: describeCause(cause),
            cause
          })
        })

        yield* store.putOAuthFlow({
          state,
          owner: options.owner,
          integration: options.integration,
          connection: options.connection,
          template: options.template,
          clientOwner: options.clientOwner,
          clientSlug: options.client,
          codeVerifier: began.codeVerifier,
          redirectUri: options.redirectUri,
          ...whenPresent("resource", client.resource),
          scopes: client.scopes
        })

        return {
          authorizationUrl: began.authorizationUrl.toString(),
          state
        }
      })

      const persistTokens = Effect.fn("OAuthFlows.persistTokens")(function* (options: {
        readonly owner: OwnerTier
        readonly integration: IntegrationSlug
        readonly connection: ConnectionName
        readonly response: typeof TokenResponse.Type
      }) {
        const now = yield* Clock.currentTimeMillis
        const expiresAt = options.response.expires_in === undefined
          ? undefined
          : now + options.response.expires_in * 1000
        const address = connectionAddress({
          owner: options.owner,
          integration: options.integration,
          connection: options.connection
        })
        const tokens: StoredTokens = {
          accessToken: options.response.access_token,
          ...whenPresent("tokenType", options.response.token_type),
          ...whenPresent("refreshToken", options.response.refresh_token),
          ...whenPresent("expiresAt", expiresAt),
          ...whenPresent("scope", options.response.scope)
        }
        yield* writeTokens(credentials, connectionCredentialKey(address), tokens)
        return {
          scope: Option.fromNullishOr(options.response.scope),
          expiresAt: Option.fromNullishOr(expiresAt)
        }
      })

      const complete = Effect.fn("OAuthFlows.complete")(function* (options: {
        readonly state: OAuthState
        readonly code: string
      }) {
        const pending = yield* store.takeOAuthFlow(options.state)
        const flow = yield* Option.match(pending, {
          onNone: () => Effect.fail(new OAuthError({
            stage: "complete",
            // A state value is deleted when it is read, so a replay and an
            // expiry are indistinguishable here — and both mean the same thing.
            detail: "This authorization is not pending; start it again"
          })),
          onSome: Effect.succeed
        })

        const client = yield* requireClient({
          owner: flow.clientOwner,
          slug: flow.clientSlug
        })
        const secret = yield* clientSecret(client)

        const exchanged = yield* Effect.tryPromise({
          try: () => exchangeAuthorization(client.authorizationUrl, {
            metadata: metadataOf(client),
            clientInformation: clientInformation(client, secret),
            authorizationCode: options.code,
            codeVerifier: flow.codeVerifier,
            redirectUri: flow.redirectUri,
            ...whenPresent("resource", resourceUrl(flow.resource))
          }),
          catch: (cause) => new OAuthError({
            stage: "complete",
            detail: describeCause(cause),
            cause
          })
        })

        const response = yield* decodeTokenResponse(exchanged).pipe(
          Effect.mapError((cause) =>
            new OAuthError({
              stage: "complete",
              detail: "The token response was unreadable",
              cause
            })
          )
        )

        const stored = yield* persistTokens({
          owner: flow.owner,
          integration: flow.integration,
          connection: flow.connection,
          response
        })

        return {
          owner: flow.owner,
          integration: flow.integration,
          connection: flow.connection,
          template: flow.template,
          clientOwner: flow.clientOwner,
          client: flow.clientSlug,
          scope: stored.scope,
          expiresAt: stored.expiresAt
        }
      })

      /** Refreshed a minute early: a token that expires while the request is in
       *  flight fails the call, and a minute costs nothing. */
      const refreshSkewMillis = 60_000

      const accessToken = Effect.fn("OAuthFlows.accessToken")(function* (reference: {
        readonly owner: OwnerTier
        readonly integration: IntegrationSlug
        readonly connection: ConnectionName
        readonly clientOwner: OwnerTier
        readonly client: OAuthClientSlug
      }) {
        const address = connectionAddress({
          owner: reference.owner,
          integration: reference.integration,
          connection: reference.connection
        })
        const key = connectionCredentialKey(address)
        const held = yield* readTokens(credentials, key)
        if (Option.isNone(held)) return Option.none<OAuthAccess>()
        const tokens = held.value

        const now = yield* Clock.currentTimeMillis
        const spent = tokens.expiresAt !== undefined &&
          tokens.expiresAt - refreshSkewMillis <= now
        if (!spent) {
          return Option.some({
            value: tokens.accessToken,
            ...whenPresent("expiresAt", tokens.expiresAt)
          })
        }

        if (tokens.refreshToken === undefined) {
          return yield* new OAuthError({
            stage: "refresh",
            detail: "The access token expired and no refresh token is available"
          })
        }

        const client = yield* requireClient({
          owner: reference.clientOwner,
          slug: reference.client
        })
        const secret = yield* clientSecret(client)

        const refreshed = yield* Effect.tryPromise({
          try: () => refreshAuthorization(client.authorizationUrl, {
            metadata: metadataOf(client),
            clientInformation: clientInformation(client, secret),
            refreshToken: tokens.refreshToken ?? "",
            ...whenPresent("resource", resourceUrl(client.resource))
          }),
          catch: (cause) => new OAuthError({
            stage: "refresh",
            detail: describeCause(cause),
            cause
          })
        })

        const response = yield* decodeTokenResponse(refreshed).pipe(
          Effect.mapError((cause) =>
            new OAuthError({
              stage: "refresh",
              detail: "The refreshed token response was unreadable",
              cause
            })
          )
        )

        // A server that omits a new refresh token means "keep the old one".
        const stored = yield* persistTokens({
          owner: reference.owner,
          integration: reference.integration,
          connection: reference.connection,
          response: response.refresh_token === undefined
            ? { ...response, refresh_token: tokens.refreshToken }
            : response
        })
        return Option.some({
          value: response.access_token,
          ...whenPresent("expiresAt", Option.getOrUndefined(stored.expiresAt))
        })
      })

      return {
        probe,
        registerDynamicClient,
        createClient,
        start,
        complete,
        accessToken
      }
    })
  )
}
