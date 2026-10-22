import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import type * as oauth from "oauth4webapi"
import { connectionAddress, ConnectionName, IntegrationSlug, webCrypto, whenPresent } from "@integragents/contracts"
import type { ConnectionOwner } from "@integragents/contracts"
import { CatalogStore } from "../catalog/store.ts"
import type { ClientAuthMethod, OAuthClientRecord } from "../catalog/store.ts"
import { AuthTemplateSlug, OAuthClientSlug, OAuthState } from "../catalog/ids.ts"
import type { Egress } from "../egress/egress.ts"
import { OAuthError, StorageError } from "../errors.ts"
import {
  connectionCredentialKey,
  CredentialStore,
  oauthClientCredentialKey,
  readTokens,
  StoredTokens
} from "../storage/credentials.ts"
import { boundScopes, OAuthProtocol, preferredAuthMethod, suppliedAuthMethod } from "./protocol.ts"
import type { ClientCredentials, Protocol, TokenResponse } from "./protocol.ts"

/** How an integration says it authorizes, as recorded on its auth method. */
export interface OAuthMethodSettings {
  readonly discoveryUrl?: string | undefined
  readonly authorizationUrl?: string | undefined
  readonly tokenUrl?: string | undefined
  readonly resource?: string | null | undefined
  readonly scopes?: ReadonlyArray<string> | undefined
  readonly registrationEndpoint?: string | undefined
}

/** What an authorization will ask for, worked out from discovery or the configured endpoints. */
export interface OAuthSetup {
  readonly server: oauth.AuthorizationServer
  /** Whether `server` came from the issuer's own metadata, so its issuer can be checked. */
  readonly discovered: boolean
  readonly resource: string | undefined
  readonly scopes: ReadonlyArray<string>
}

export interface StartOptions {
  readonly owner: ConnectionOwner
  readonly clientOwner: ConnectionOwner
  readonly client: OAuthClientSlug
  readonly integration: IntegrationSlug
  readonly connection: ConnectionName
  readonly template: AuthTemplateSlug
  readonly redirectUri: string
}

export interface CompletedAuthorization {
  readonly owner: ConnectionOwner
  readonly integration: IntegrationSlug
  readonly connection: ConnectionName
  readonly template: AuthTemplateSlug
  readonly clientOwner: ConnectionOwner
  readonly client: OAuthClientSlug
  readonly scope: Option.Option<string>
  readonly expiresAt: Option.Option<number>
}

export interface OAuthAccess {
  readonly value: string
  readonly expiresAt?: number
}

export interface ConnectionGrant {
  readonly owner: ConnectionOwner
  readonly integration: IntegrationSlug
  readonly connection: ConnectionName
  readonly clientOwner: ConnectionOwner
  readonly client: OAuthClientSlug
}

const offlineAccessScope = "offline_access"
const refreshSkewMillis = 60_000
/** A claim older than this belonged to a refresh that may have spent a rotating token before failing. */
const abandonedClaimMillis = 60_000
const claimPollInterval = "100 millis"
const minimumStateLength = 32

const serverOf = (client: OAuthClientRecord): oauth.AuthorizationServer => ({
  issuer: client.issuer ?? new URL(client.tokenUrl).origin,
  authorization_endpoint: client.authorizationUrl,
  token_endpoint: client.tokenUrl,
  authorization_response_iss_parameter_supported: client.issParameterSupported
})

const encodeTokens = Schema.encodeSync(Schema.fromJsonString(StoredTokens))

const failure = (stage: OAuthError["stage"], reason: OAuthError["reason"], detail: string) =>
  new OAuthError({ stage, reason, detail })

/** Failures that mean the grant itself is dead, as opposed to the provider being unreachable for now. */
const deadGrant = (error: OAuthError): boolean =>
  error.reason === "invalid_grant" ||
  error.reason === "invalid_client" ||
  error.reason === "invalid_scope" ||
  error.reason === "destination_blocked"

export class OAuthFlows extends Context.Service<
  OAuthFlows,
  {
    readonly discover: (settings: OAuthMethodSettings) => Effect.Effect<OAuthSetup, OAuthError>
    /** The protected resource metadata and challenge `endpoint` publishes, if any. */
    readonly discoverResource: Protocol["discoverResource"]
    readonly registerClient: (options: {
      readonly owner: ConnectionOwner
      readonly slug: OAuthClientSlug
      readonly integration: IntegrationSlug
      readonly setup: OAuthSetup
      readonly redirectUri: string
    }) => Effect.Effect<OAuthClientSlug, OAuthError | StorageError>
    /** Records a client the gateway did not register itself: one a person created, or its metadata document. */
    readonly saveClient: (options: {
      readonly owner: ConnectionOwner
      readonly slug: OAuthClientSlug
      readonly integration: IntegrationSlug
      readonly setup: OAuthSetup
      readonly clientId: string
      readonly clientSecret?: string | undefined
      readonly tokenAuthMethod?: ClientAuthMethod
    }) => Effect.Effect<OAuthClientSlug, StorageError>
    readonly start: (
      options: StartOptions
    ) => Effect.Effect<{ readonly authorizationUrl: string; readonly state: OAuthState }, OAuthError | StorageError>
    /** Finishes the authorization the callback's parameters belong to. */
    readonly complete: (callback: URLSearchParams) => Effect.Effect<CompletedAuthorization, OAuthError | StorageError>
    /**
     * The connection's current access token, refreshed when it is about to
     * expire or when `renew` says the provider just rejected it.
     */
    readonly accessToken: (
      grant: ConnectionGrant,
      options?: { readonly renew?: boolean }
    ) => Effect.Effect<Option.Option<OAuthAccess>, OAuthError | StorageError>
  }
>()("@integragents/integrations/OAuthFlows") {
  static readonly layer: Layer.Layer<OAuthFlows, never, CatalogStore | CredentialStore | Egress> = Layer.effect(
    OAuthFlows,
    Effect.gen(function* () {
      const store = yield* CatalogStore
      const credentials = yield* CredentialStore
      const protocol = yield* OAuthProtocol

      const clientSecret = (record: OAuthClientRecord) =>
        credentials.get(oauthClientCredentialKey(record.owner, record.slug))

      const requireClient = Effect.fn("OAuthFlows.requireClient")(function* (
        stage: OAuthError["stage"],
        reference: { readonly owner: ConnectionOwner; readonly slug: OAuthClientSlug }
      ) {
        const found = yield* store.findOAuthClient(reference)
        if (Option.isNone(found)) {
          return yield* failure(stage, "invalid_client", `No OAuth client ${reference.owner}/${reference.slug}`)
        }
        const secret = yield* clientSecret(found.value)
        const credentials: ClientCredentials = {
          clientId: found.value.clientId,
          clientSecret: Option.getOrUndefined(secret),
          tokenAuthMethod: found.value.tokenAuthMethod ?? "client_secret_post"
        }
        return { record: found.value, credentials }
      })

      const discover = Effect.fn("OAuthFlows.discover")(function* (settings: OAuthMethodSettings) {
        if (settings.discoveryUrl === undefined) {
          if (settings.authorizationUrl === undefined || settings.tokenUrl === undefined) {
            return yield* failure("discover", "unsupported", "No authorization and token endpoints are configured")
          }
          const authorizationUrl = yield* protocol.destination("discover", settings.authorizationUrl)
          const tokenUrl = yield* protocol.destination("discover", settings.tokenUrl)
          const registrationEndpoint =
            settings.registrationEndpoint === undefined
              ? undefined
              : yield* protocol.destination("discover", settings.registrationEndpoint)
          return {
            server: {
              issuer: tokenUrl.origin,
              authorization_endpoint: authorizationUrl.href,
              token_endpoint: tokenUrl.href,
              ...whenPresent("registration_endpoint", registrationEndpoint?.href)
            },
            discovered: false,
            resource: settings.resource ?? undefined,
            scopes: boundScopes(settings.scopes ?? [])
          } satisfies OAuthSetup
        }
        const found = yield* protocol.discoverServer(settings.discoveryUrl)
        const methods = found.server.code_challenge_methods_supported
        if (methods !== undefined && !methods.includes("S256")) {
          return yield* failure("discover", "unsupported", "The authorization server does not support PKCE with S256")
        }
        const resource = Option.getOrUndefined(found.resource)
        const challenge = Option.getOrUndefined(found.challenge)
        const requested = settings.scopes ?? challenge?.scopes ?? resource?.scopes_supported ?? []
        const scopes =
          found.server.scopes_supported?.includes(offlineAccessScope) === true &&
          !requested.includes(offlineAccessScope)
            ? [...requested, offlineAccessScope]
            : requested
        return {
          server: found.server,
          discovered: true,
          resource: settings.resource === null ? undefined : (settings.resource ?? resource?.resource),
          scopes: boundScopes(scopes)
        } satisfies OAuthSetup
      })

      const clientRecord = (options: {
        readonly owner: ConnectionOwner
        readonly slug: OAuthClientSlug
        readonly integration: IntegrationSlug
        readonly setup: OAuthSetup
        readonly clientId: string
        readonly tokenAuthMethod: ClientAuthMethod
        readonly secretExpiresAt?: number | undefined
      }): Effect.Effect<OAuthClientRecord, OAuthError> => {
        const server = options.setup.server
        if (server.authorization_endpoint === undefined || server.token_endpoint === undefined) {
          return Effect.fail(failure("register", "unsupported", "The provider has no authorization or token endpoint"))
        }
        return Effect.succeed({
          owner: options.owner,
          slug: options.slug,
          integration: options.integration,
          clientId: options.clientId,
          authorizationUrl: server.authorization_endpoint,
          tokenUrl: server.token_endpoint,
          ...whenPresent("registrationEndpoint", server.registration_endpoint),
          ...whenPresent("issuer", options.setup.discovered ? server.issuer : undefined),
          ...whenPresent("resource", options.setup.resource),
          scopes: options.setup.scopes,
          tokenAuthMethod: options.tokenAuthMethod,
          issParameterSupported:
            options.setup.discovered && server.authorization_response_iss_parameter_supported === true,
          ...whenPresent("secretExpiresAt", options.secretExpiresAt)
        })
      }

      const registerClient = Effect.fn("OAuthFlows.registerClient")(function* (options: {
        readonly owner: ConnectionOwner
        readonly slug: OAuthClientSlug
        readonly integration: IntegrationSlug
        readonly setup: OAuthSetup
        readonly redirectUri: string
      }) {
        if (options.setup.server.registration_endpoint === undefined) {
          return yield* failure("register", "unsupported", "The provider does not offer dynamic client registration")
        }
        const registered = yield* protocol.register({
          server: options.setup.server,
          redirectUri: options.redirectUri,
          scopes: options.setup.scopes,
          tokenAuthMethod: preferredAuthMethod(options.setup.server)
        })
        yield* store.putOAuthClient(
          yield* clientRecord({
            ...options,
            clientId: registered.clientId,
            tokenAuthMethod: registered.tokenAuthMethod,
            secretExpiresAt: registered.secretExpiresAt
          })
        )
        if (registered.clientSecret !== undefined) {
          yield* credentials.set(oauthClientCredentialKey(options.owner, options.slug), registered.clientSecret)
        }
        return options.slug
      })

      const saveClient = Effect.fn("OAuthFlows.saveClient")(function* (options: {
        readonly owner: ConnectionOwner
        readonly slug: OAuthClientSlug
        readonly integration: IntegrationSlug
        readonly setup: OAuthSetup
        readonly clientId: string
        readonly clientSecret?: string | undefined
        readonly tokenAuthMethod?: ClientAuthMethod
      }) {
        const secret =
          options.clientSecret === undefined || options.clientSecret.length === 0 ? undefined : options.clientSecret
        const record = yield* clientRecord({
          ...options,
          tokenAuthMethod: options.tokenAuthMethod ?? suppliedAuthMethod(options.setup.server, secret !== undefined)
        }).pipe(Effect.mapError((cause) => new StorageError({ message: cause.detail })))
        yield* store.putOAuthClient(record)
        const key = oauthClientCredentialKey(options.owner, options.slug)
        yield* secret === undefined ? credentials.remove(key) : credentials.set(key, secret)
        return options.slug
      })

      const start = Effect.fn("OAuthFlows.start")(function* (options: StartOptions) {
        const client = yield* requireClient("start", { owner: options.clientOwner, slug: options.client })
        const began = yield* protocol.authorizationRequest({
          server: serverOf(client.record),
          client: client.credentials,
          redirectUri: options.redirectUri,
          scopes: client.record.scopes,
          resource: client.record.resource,
          withNonce: client.record.issuer !== undefined && client.record.scopes.includes("openid")
        })
        const state = OAuthState.make(began.state)
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
          ...whenPresent("resource", client.record.resource),
          scopes: client.record.scopes,
          ...whenPresent("nonce", began.nonce)
        })
        return { authorizationUrl: began.authorizationUrl, state }
      })

      const persistTokens = Effect.fn("OAuthFlows.persistTokens")(function* (
        response: TokenResponse,
        previous: Option.Option<StoredTokens>
      ) {
        const now = yield* Clock.currentTimeMillis
        const refreshToken =
          response.refresh_token ??
          Option.getOrUndefined(Option.flatMapNullishOr(previous, (tokens) => tokens.refreshToken))
        const expiresAt = response.expires_in === undefined ? undefined : now + response.expires_in * 1000
        const tokens: StoredTokens = {
          accessToken: response.access_token,
          tokenType: response.token_type,
          ...whenPresent("refreshToken", refreshToken),
          ...whenPresent("expiresAt", expiresAt),
          ...whenPresent("scope", response.scope)
        }
        return tokens
      })

      const callbackFailure = (detail: string) => failure("complete", "invalid_callback", detail)

      const complete = Effect.fn("OAuthFlows.complete")(function* (callback: URLSearchParams) {
        const states = callback.getAll("state")
        const state = states[0]
        if (states.length !== 1 || state === undefined || state.length < minimumStateLength) {
          return yield* callbackFailure("The callback does not carry exactly one valid state")
        }
        const pending = yield* store.takeOAuthFlow(OAuthState.make(state))
        if (Option.isNone(pending)) {
          return yield* failure("complete", "not_pending", "This authorization is not pending; start it again")
        }
        const flow = pending.value
        const redirect = new URL(flow.redirectUri)
        for (const name of new Set(redirect.searchParams.keys())) {
          const expected = redirect.searchParams.getAll(name)
          const actual = callback.getAll(name)
          if (expected.length !== actual.length || expected.some((value, index) => actual[index] !== value)) {
            return yield* callbackFailure("The callback does not match the redirect it was sent to")
          }
        }
        const callbackUrl = new URL(redirect)
        callbackUrl.search = callback.toString()

        const client = yield* requireClient("complete", { owner: flow.clientOwner, slug: flow.clientSlug })
        const response = yield* protocol.exchange({
          server: serverOf(client.record),
          client: client.credentials,
          callback: callbackUrl,
          state,
          redirectUri: flow.redirectUri,
          codeVerifier: flow.codeVerifier,
          resource: flow.resource,
          nonce: flow.nonce
        })
        const tokens = yield* persistTokens(response, Option.none())
        const address = connectionAddress({
          owner: flow.owner,
          integration: flow.integration,
          connection: flow.connection
        })
        yield* credentials.set(connectionCredentialKey(address), encodeTokens(tokens))
        return {
          owner: flow.owner,
          integration: flow.integration,
          connection: flow.connection,
          template: flow.template,
          clientOwner: flow.clientOwner,
          client: flow.clientSlug,
          scope: Option.fromNullishOr(tokens.scope),
          expiresAt: tokens.refreshToken === undefined ? Option.fromNullishOr(tokens.expiresAt) : Option.none()
        } satisfies CompletedAuthorization
      })

      const reconnect = (grant: ConnectionGrant, reason: string) =>
        store
          .requireReconnect({ owner: grant.owner, integration: grant.integration, name: grant.connection }, reason)
          .pipe(Effect.andThen(Effect.fail(failure("refresh", "reconnect_required", reason))))

      const accessOf = (tokens: StoredTokens): OAuthAccess => ({
        value: tokens.accessToken,
        ...whenPresent("expiresAt", tokens.refreshToken === undefined ? tokens.expiresAt : undefined)
      })

      const accessToken = Effect.fn("OAuthFlows.accessToken")(function* (
        grant: ConnectionGrant,
        options: { readonly renew?: boolean } = {}
      ) {
        const key = connectionCredentialKey(connectionAddress(grant))
        let rejected: string | undefined
        let first = true
        while (true) {
          const connection = (yield* store.listConnections({
            owner: grant.owner,
            integration: grant.integration,
            name: grant.connection
          }))[0]
          if (connection?.reconnectReason !== undefined) {
            return yield* failure("refresh", "reconnect_required", connection.reconnectReason)
          }
          const held = yield* readTokens(credentials, key)
          if (Option.isNone(held)) return Option.none<OAuthAccess>()
          const tokens = held.value
          if (first && options.renew === true) rejected = tokens.accessToken
          first = false
          const now = yield* Clock.currentTimeMillis
          const expired = tokens.expiresAt !== undefined && tokens.expiresAt - refreshSkewMillis <= now
          if (!expired && tokens.accessToken !== rejected) return Option.some(accessOf(tokens))
          const refreshToken = tokens.refreshToken
          if (refreshToken === undefined) {
            return yield* reconnect(
              grant,
              expired
                ? "The access token expired and no refresh token is available"
                : "The provider rejected the access token and issued no refresh token"
            )
          }

          const claim = yield* Effect.orDie(webCrypto.randomUUIDv4)
          const claimed = yield* credentials.claim(key, claim, now)
          if (claimed._tag === "Missing") return Option.none<OAuthAccess>()
          if (claimed._tag === "Held") {
            if (now - claimed.since > abandonedClaimMillis) {
              return yield* reconnect(grant, "A token refresh was interrupted before it finished")
            }
            yield* Effect.sleep(claimPollInterval)
            continue
          }

          const client = yield* requireClient("refresh", { owner: grant.clientOwner, slug: grant.client })
          const refreshed = yield* Effect.result(
            protocol.refresh({
              server: serverOf(client.record),
              client: client.credentials,
              refreshToken,
              resource: client.record.resource
            })
          )
          if (refreshed._tag === "Failure") {
            yield* credentials.settleClaim(key, claim, Option.none())
            const error = refreshed.failure
            return yield* deadGrant(error)
              ? reconnect(grant, `The provider refused the refresh: ${error.detail}`)
              : Effect.fail(error)
          }
          const next = yield* persistTokens(refreshed.success, Option.some(tokens))
          const settled = yield* credentials.settleClaim(key, claim, Option.some(encodeTokens(next)))
          if (!settled) continue
          return Option.some(accessOf(next))
        }
      })

      return {
        discover,
        discoverResource: protocol.discoverResource,
        registerClient,
        saveClient,
        start,
        complete,
        accessToken
      }
    })
  ).pipe(Layer.provide(OAuthProtocol.layer))
}
