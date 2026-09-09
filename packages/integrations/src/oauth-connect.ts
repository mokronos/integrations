import { Clock, Effect, Option, Schema } from "effect"
import { whenPresent } from "@integrations/contracts"
import {
  Connection,
  connectionAddress,
  ConnectionName,
  IntegrationSlug,
  type OAuthServerProbe,
  type OwnerTier
} from "@integrations/contracts"
import { AuthTemplateSlug, OAuthClientSlug, OAuthState } from "./catalog/ids.ts"
import { CatalogStore } from "./catalog/store.ts"
import { InvalidInputError, type StorageError, type OAuthError } from "./errors.ts"
import { Integrations } from "./integrations.ts"
import { OAuthFlows } from "./oauth/flows.ts"

const decodeId = <A, I>(
  schema: Schema.Codec<A, I, never, never>,
  field: string,
  value: I
): Effect.Effect<A, InvalidInputError> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      new InvalidInputError({ field, detail: `${String(value)} is not a valid ${field}: ${cause}` }))
  )

const defaultOwner: OwnerTier = "org"

export const probeOAuthServer = (
  url: string
): Effect.Effect<OAuthServerProbe, OAuthError, OAuthFlows> =>
  Effect.flatMap(OAuthFlows, (oauth) => oauth.probe(url))

export interface RegisterOAuthClientOptions {
  readonly slug: string
  readonly integration: string
  readonly redirectUri: string
  readonly registrationEndpoint: string
  readonly authorizationUrl: string
  readonly tokenUrl: string
  readonly issuer?: string
  readonly resource?: string
  readonly scopes: ReadonlyArray<string>
  readonly tokenEndpointAuthMethodsSupported?: ReadonlyArray<string>
}

export const registerOAuthClient = Effect.fn("OAuthConnect.registerClient")(function*(
  options: RegisterOAuthClientOptions
) {
  const oauth = yield* OAuthFlows
  const slug = yield* decodeId(OAuthClientSlug, "client", options.slug)
  const integration = yield* decodeId(IntegrationSlug, "integration", options.integration)
  return yield* oauth.registerDynamicClient({
    owner: defaultOwner,
    slug,
    integration,
    redirectUri: options.redirectUri,
    registrationEndpoint: options.registrationEndpoint,
    authorizationUrl: options.authorizationUrl,
    tokenUrl: options.tokenUrl,
    ...whenPresent("issuer", options.issuer),
    ...whenPresent("resource", options.resource),
    scopes: options.scopes,
    ...whenPresent("tokenAuthMethods", options.tokenEndpointAuthMethodsSupported)
  })
})

export interface CreateOAuthClientOptions {
  readonly slug: string
  readonly integration: string
  readonly authorizationUrl: string
  readonly tokenUrl: string
  readonly clientId: string
  readonly clientSecret?: string
  readonly resource?: string
  readonly scopes?: ReadonlyArray<string>
}

export const createOAuthClient = Effect.fn("OAuthConnect.createClient")(function*(
  options: CreateOAuthClientOptions
) {
  const oauth = yield* OAuthFlows
  const slug = yield* decodeId(OAuthClientSlug, "client", options.slug)
  const integration = yield* decodeId(IntegrationSlug, "integration", options.integration)
  return yield* oauth.createClient({
    owner: defaultOwner,
    slug,
    integration,
    authorizationUrl: options.authorizationUrl,
    tokenUrl: options.tokenUrl,
    clientId: options.clientId,
    ...whenPresent("clientSecret", options.clientSecret),
    ...whenPresent("resource", options.resource),
    ...whenPresent("scopes", options.scopes)
  })
})

export interface StartOAuthFlowOptions {
  readonly client: string
  readonly integration: string
  readonly connection: string
  readonly template: string
  readonly redirectUri: string
}

export type StartedOAuthFlow =
  | { readonly status: "connected"; readonly connection: Connection }
  | { readonly status: "redirect"; readonly authorizationUrl: string; readonly state: string }

export const startOAuthFlow = Effect.fn("OAuthConnect.start")(function*(
  options: StartOAuthFlowOptions
): Effect.fn.Return<StartedOAuthFlow, OAuthError | StorageError | InvalidInputError, OAuthFlows> {
  const oauth = yield* OAuthFlows
  const client = yield* decodeId(OAuthClientSlug, "client", options.client)
  const integration = yield* decodeId(IntegrationSlug, "integration", options.integration)
  const connection = yield* decodeId(ConnectionName, "connection", options.connection)
  const template = yield* decodeId(AuthTemplateSlug, "template", options.template)
  const started = yield* oauth.start({
    owner: defaultOwner,
    clientOwner: defaultOwner,
    client,
    integration,
    connection,
    template,
    redirectUri: options.redirectUri
  })
  return {
    status: "redirect",
    authorizationUrl: started.authorizationUrl,
    state: started.state
  }
})

export const completeOAuthFlow = Effect.fn("OAuthConnect.complete")(function*(
  options: { readonly state: string; readonly code: string }
) {
  const host = yield* Integrations
  const oauth = yield* OAuthFlows
  const store = yield* CatalogStore
  const state = yield* decodeId(OAuthState, "state", options.state)
  const completed = yield* oauth.complete({ state, code: options.code })
  const now = yield* Clock.currentTimeMillis
  const record = {
    owner: completed.owner,
    integration: completed.integration,
    name: completed.connection,
    template: completed.template,
    provider: "oauth",
    oauthClient: completed.client,
    oauthClientOwner: completed.clientOwner,
    ...whenPresent("oauthScope", Option.getOrUndefined(completed.scope)),
    ...whenPresent("expiresAt", Option.getOrUndefined(completed.expiresAt)),
    createdAt: now
  }
  yield* store.putConnection(record)

  const captured = yield* Effect.result(host.refreshConnection({
    owner: record.owner,
    integration: record.integration,
    name: record.name
  }))
  const captureError = captured._tag === "Failure"
    ? `Connected, but the tool list could not be read: ${captured.failure.message}`
    : undefined
  if (captureError !== undefined) {
    yield* Effect.logWarning(captureError).pipe(
      Effect.annotateLogs({
        integration: record.integration,
        connection: record.name,
        operation: "refreshConnection"
      })
    )
  }

  return yield* Schema.decodeUnknownEffect(Connection)({
    owner: record.owner,
    name: record.name,
    integration: record.integration,
    template: record.template,
    address: connectionAddress({
      owner: record.owner,
      integration: record.integration,
      connection: record.name
    }),
    provider: record.provider,
    oauthClient: record.oauthClient,
    oauthClientOwner: record.oauthClientOwner,
    oauthScope: Option.getOrNull(completed.scope),
    expiresAt: Option.getOrNull(completed.expiresAt),
    missingOAuthScopes: [],
    status: "connected",
    ...whenPresent("error", captureError)
  }).pipe(Effect.mapError((cause) =>
    new InvalidInputError({
      field: "connection",
      detail: `The completed connection could not be described: ${cause}`
    })))
})
