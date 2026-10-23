import { Clock, Effect, Option, Schema } from "effect"
import { InvalidInput, whenPresent } from "@integragents/contracts"
import {
  Connection,
  connectionAddress,
  ConnectionName,
  IntegrationSlug,
  type ConnectionOwner
} from "@integragents/contracts"
import { AuthTemplateSlug, OAuthClientSlug } from "../catalog/ids.ts"
import { CatalogStore } from "../catalog/store.ts"
import type { ClientAuthMethod } from "../catalog/store.ts"
import type { OAuthError, StorageError } from "../errors.ts"
import { Integrations } from "../integrations.ts"
import { OAuthFlows } from "./flows.ts"
import type { OAuthMethodSettings, OAuthSetup } from "./flows.ts"

const decodeId = <A, I>(
  schema: Schema.Codec<A, I, never, never>,
  field: string,
  value: I
): Effect.Effect<A, InvalidInput> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) => new InvalidInput({ field, problem: `${String(value)} is not a valid ${field}: ${cause}` })
    )
  )

const defaultOwner: ConnectionOwner = "org"

export const discoverOAuth = (settings: OAuthMethodSettings): Effect.Effect<OAuthSetup, OAuthError, OAuthFlows> =>
  Effect.flatMap(OAuthFlows, (oauth) => oauth.discover(settings))

export const registerOAuthClient = Effect.fn("OAuthConnect.registerClient")(function* (options: {
  readonly slug: string
  readonly integration: string
  readonly setup: OAuthSetup
  readonly redirectUri: string
}) {
  const oauth = yield* OAuthFlows
  return yield* oauth.registerClient({
    owner: defaultOwner,
    slug: yield* decodeId(OAuthClientSlug, "client", options.slug),
    integration: yield* decodeId(IntegrationSlug, "integration", options.integration),
    setup: options.setup,
    redirectUri: options.redirectUri
  })
})

export const findOAuthClient = Effect.fn("OAuthConnect.findClient")(function* (slug: string) {
  const store = yield* CatalogStore
  const decoded = yield* decodeId(OAuthClientSlug, "client", slug)
  return yield* store.findOAuthClient({ owner: defaultOwner, slug: decoded })
})

export const saveOAuthClient = Effect.fn("OAuthConnect.saveClient")(function* (options: {
  readonly slug: string
  readonly integration: string
  readonly setup: OAuthSetup
  readonly clientId: string
  readonly clientSecret?: string | undefined
  readonly tokenAuthMethod?: ClientAuthMethod
}) {
  const oauth = yield* OAuthFlows
  return yield* oauth.saveClient({
    owner: defaultOwner,
    slug: yield* decodeId(OAuthClientSlug, "client", options.slug),
    integration: yield* decodeId(IntegrationSlug, "integration", options.integration),
    setup: options.setup,
    clientId: options.clientId,
    ...whenPresent("clientSecret", options.clientSecret),
    ...whenPresent("tokenAuthMethod", options.tokenAuthMethod)
  })
})

export interface StartOAuthFlowOptions {
  readonly client: string
  readonly integration: string
  readonly connection: string
  readonly template: string
  readonly redirectUri: string
  /** Who the resulting connection belongs to. The OAuth client stays the organisation's. */
  readonly owner?: ConnectionOwner
}

export type StartedOAuthFlow =
  | { readonly status: "connected"; readonly connection: Connection }
  | { readonly status: "redirect"; readonly authorizationUrl: string; readonly state: string }

export const startOAuthFlow = Effect.fn("OAuthConnect.start")(function* (
  options: StartOAuthFlowOptions
): Effect.fn.Return<StartedOAuthFlow, OAuthError | StorageError | InvalidInput, OAuthFlows> {
  const oauth = yield* OAuthFlows
  const client = yield* decodeId(OAuthClientSlug, "client", options.client)
  const integration = yield* decodeId(IntegrationSlug, "integration", options.integration)
  const connection = yield* decodeId(ConnectionName, "connection", options.connection)
  const template = yield* decodeId(AuthTemplateSlug, "template", options.template)
  const started = yield* oauth.start({
    owner: options.owner ?? defaultOwner,
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

/** Finishes an authorization from the parameters its callback arrived with. */
export const completeOAuthFlow = Effect.fn("OAuthConnect.complete")(function* (callback: URLSearchParams) {
  const host = yield* Integrations
  const oauth = yield* OAuthFlows
  const store = yield* CatalogStore
  const completed = yield* oauth.complete(callback)
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
    createdAt: now
  }
  yield* store.putConnection(record)

  const captured = yield* Effect.result(
    host.refreshConnection({
      owner: record.owner,
      integration: record.integration,
      name: record.name
    })
  )
  const captureError =
    captured._tag === "Failure"
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

  const expiry = Option.getOrUndefined(completed.expiresAt)
  const renewalWarning =
    expiry === undefined
      ? undefined
      : `Connected, but ${record.integration} issued no refresh token: this ` +
        `connection stops working at ${new Date(expiry).toISOString()} and has to ` +
        `be authorized again. Grant consent when the provider asks for it.`
  if (renewalWarning !== undefined) {
    yield* Effect.logWarning(renewalWarning).pipe(
      Effect.annotateLogs({
        integration: record.integration,
        connection: record.name,
        operation: "completeOAuthFlow"
      })
    )
  }

  const notices = [renewalWarning, captureError].filter((notice) => notice !== undefined)

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
    ...whenPresent("error", notices.length === 0 ? undefined : notices.join(" "))
  }).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidInput({
          field: "connection",
          problem: `The completed connection could not be described: ${cause}`
        })
    )
  )
})
