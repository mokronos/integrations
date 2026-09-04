import { Clock, Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { CatalogStore } from "../catalog/store.ts"
import { InvalidInputError } from "../errors.ts"
import type { HostHandle } from "./lifecycle.ts"
import { HostHandleService } from "./lifecycle.ts"
import { AuthTemplateSlug, OAuthClientSlug, OAuthState } from "../catalog/ids.ts"
import { connectionAddress, ConnectionName, EndpointClassification, IntegrationSlug } from "@mokronos/contracts"
import { IntegrationHost } from "../host.ts"
import type { ToolFilter } from "../host.ts"
import { OAuthFlows } from "../oauth/flows.ts"
import { whenPresent } from "@mokronos/contracts"
import {
  Connection,
  Integration,
  OAuthServerProbe,
  OAuthStart,
  OwnerTier,
  Tool,
  ToolAddress,
  ToolSummary
} from "@mokronos/contracts"
import { classify } from "../classify.ts"
import { createIntegrationOverview } from "./overview.ts"
import { createIntegrationProvisioning } from "./provisioning.ts"
import { createIntegrationValidation } from "./validation.ts"

/** The Promise-facing surface of the host.
 *
 *  The package's own code is Effect throughout; the gateway, the CLI and the
 *  dashboard are async/await. Rather than scatter `runPromise` through those,
 *  the translation happens once, here, and every method reports failure the way
 *  a JavaScript caller expects — by rejecting.
 *
 *  This layer also decodes: callers pass plain strings for slugs and connection
 *  names, and a branded identifier is produced at this boundary rather than
 *  trusted from outside. */

type Json = typeof Schema.Json.Type

/** Decodes a caller-supplied identifier, rejecting rather than proceeding with
 *  something the catalog could not address. */
const decodeId = <A>(
  schema: Schema.Codec<A, string>,
  field: string,
  value: string
): Effect.Effect<A, InvalidInputError> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new InvalidInputError({
      field,
      detail: `${JSON.stringify(value)} is not a valid ${field}`
    }))
  )

const decodeOwner = (value: string): Effect.Effect<OwnerTier, InvalidInputError> =>
  Schema.decodeUnknownEffect(OwnerTier)(value).pipe(
    Effect.mapError(() => new InvalidInputError({
      field: "owner",
      detail: `${JSON.stringify(value)} is neither "org" nor "user"`
    }))
  )

export interface CatalogApi {
  readonly classify: (url: string) => Promise<EndpointClassification>
  readonly addMcp: (options: {
    readonly endpoint: string
    readonly name: string
    readonly slug: string
  }) => Promise<string>
  readonly addOpenApi: (options: {
    readonly spec: string
    readonly slug: string
    readonly name?: string
    readonly description?: string
    readonly baseUrl?: string
  }) => Promise<string>
  readonly list: () => Promise<ReadonlyArray<Integration>>
  readonly find: (slug: string) => Promise<Integration | undefined>
  /** Changes what an integration is called. Not what it is addressed as: the
   *  slug is in every tool address and alias already written. */
  readonly rename: (slug: string, name: string) => Promise<Integration>
  /** Removes the integration and every connection made against it. */
  readonly remove: (slug: string) => Promise<void>
}

export interface ConnectionsApi {
  readonly create: (options: {
    readonly owner?: string
    readonly integration: string
    readonly name: string
    readonly template: string
    readonly value?: string
    readonly values?: Readonly<Record<string, string>>
  }) => Promise<Connection>
  readonly list: () => Promise<ReadonlyArray<Connection>>
  readonly remove: (options: {
    readonly owner?: string
    readonly integration: string
    readonly name: string
  }) => Promise<void>
  /** Creates the default unauthenticated connection when the integration
   *  permits one. Authenticated integrations are left for an explicit flow. */
  readonly ensure: (
    integration: Integration,
    connectionName: string
  ) => Promise<boolean>
}

export interface AuthApi {
  readonly probe: (url: string) => Promise<OAuthServerProbe>
  readonly registerClient: (options: {
    readonly slug: string
    readonly integration: string
    readonly redirectUri: string
    readonly issuer?: string | null
    readonly registrationEndpoint: string
    readonly authorizationUrl: string
    readonly tokenUrl: string
    readonly resource?: string | null
    readonly scopes: ReadonlyArray<string>
    readonly tokenEndpointAuthMethodsSupported?: ReadonlyArray<string>
  }) => Promise<string>
  readonly createClient: (options: {
    readonly slug: string
    readonly integration: string
    readonly authorizationUrl: string
    readonly tokenUrl: string
    readonly clientId: string
    readonly clientSecret?: string
    readonly resource?: string | null
    readonly scopes?: ReadonlyArray<string>
  }) => Promise<string>
  readonly start: (options: {
    readonly client: string
    readonly integration: string
    readonly connection: string
    readonly template: string
    readonly redirectUri: string
  }) => Promise<OAuthStart>
  readonly complete: (options: {
    readonly state: string
    readonly code: string
    readonly callbackDomain?: string | null
  }) => Promise<Connection>
}

export interface ToolLookup {
  readonly integration: string
  readonly name: string
  readonly connection?: string
}

export interface ToolQuery {
  readonly integration?: string
  readonly owner?: OwnerTier
  readonly connection?: string
}

export interface ToolsApi {
  readonly list: (filter?: ToolQuery) => Promise<ReadonlyArray<Tool>>
  readonly summaries: (
    filter?: ToolQuery
  ) => Promise<ReadonlyArray<ToolSummary>>
  readonly describe: (
    target: ToolAddress | ToolLookup
  ) => Promise<Tool>
  readonly execute: (address: ToolAddress, input: Json) => Promise<Json>
}

/** Translates a caller's tool filter into the branded one the host wants. */
const decodeToolQuery = (
  filter: ToolQuery
): Effect.Effect<ToolFilter, InvalidInputError> =>
  Effect.gen(function* () {
    const integration = filter.integration === undefined
      ? undefined
      : yield* decodeId(IntegrationSlug, "integration", filter.integration)
    const connection = filter.connection === undefined
      ? undefined
      : yield* decodeId(ConnectionName, "connection", filter.connection)
    return {
      ...whenPresent("integration", integration),
      ...whenPresent("owner", filter.owner),
      ...whenPresent("connection", connection)
    }
  })

/** The default owner tier when a caller names none. Shared credentials are the
 *  common case, and a caller that means otherwise says so. */
const defaultOwner: OwnerTier = "org"

const buildCatalog = (host: HostHandle): CatalogApi => ({
  classify: (url) => host.run(classify(url)),
  addMcp: (options) => host.run(Effect.gen(function* () {
    const integrations = yield* IntegrationHost
    const slug = yield* decodeId(IntegrationSlug, "slug", options.slug)
    return yield* integrations.addMcp({
      endpoint: options.endpoint,
      name: options.name,
      slug
    })
  })),
  addOpenApi: (options) => host.run(Effect.gen(function* () {
    const integrations = yield* IntegrationHost
    const slug = yield* decodeId(IntegrationSlug, "slug", options.slug)
    return yield* integrations.addOpenApi({
      spec: options.spec,
      slug,
      ...whenPresent("name", options.name),
      ...whenPresent("description", options.description),
      ...whenPresent("baseUrl", options.baseUrl)
    })
  })),
  list: () => host.run(Effect.gen(function* () {
    const integrations = yield* IntegrationHost
    return yield* integrations.listIntegrations()
  })),
  find: (slug) => host.run(Effect.gen(function* () {
    const integrations = yield* IntegrationHost
    const decoded = yield* Effect.result(decodeId(IntegrationSlug, "slug", slug))
    if (decoded._tag === "Failure") return undefined
    const found = yield* integrations.findIntegration(decoded.success)
    return Option.getOrUndefined(found)
  })),
  rename: (slug, name) => host.run(Effect.gen(function* () {
    const integrations = yield* IntegrationHost
    const decoded = yield* decodeId(IntegrationSlug, "slug", slug)
    yield* integrations.renameIntegration(decoded, name)
    const renamed = yield* integrations.findIntegration(decoded)
    return yield* Option.match(renamed, {
      onNone: () => Effect.die(new Error(`The catalog lost integration ${slug} while renaming it`)),
      onSome: Effect.succeed
    })
  })),
  remove: (slug) => host.run(Effect.gen(function* () {
    const integrations = yield* IntegrationHost
    const decoded = yield* decodeId(IntegrationSlug, "slug", slug)
    yield* integrations.removeIntegration(decoded)
  }))
})

const buildConnections = (host: HostHandle): ConnectionsApi => {
  const create: ConnectionsApi["create"] = (options) =>
    host.run(Effect.gen(function* () {
      const integrations = yield* IntegrationHost
      const owner = options.owner === undefined
        ? defaultOwner
        : yield* decodeOwner(options.owner)
      const integration = yield* decodeId(IntegrationSlug, "integration", options.integration)
      const name = yield* decodeId(ConnectionName, "connection", options.name)
      const template = yield* decodeId(AuthTemplateSlug, "template", options.template)
      return yield* integrations.createConnection({
        owner,
        integration,
        name,
        template,
        ...whenPresent("value", options.value),
        ...whenPresent("values", options.values)
      })
    }))

  const list: ConnectionsApi["list"] = () =>
    host.run(Effect.gen(function* () {
      const integrations = yield* IntegrationHost
      return yield* integrations.listConnections()
    }))

  return {
    create,
    list,
    remove: (options) => host.run(Effect.gen(function* () {
      const integrations = yield* IntegrationHost
      const owner = options.owner === undefined
        ? defaultOwner
        : yield* decodeOwner(options.owner)
      const integration = yield* decodeId(IntegrationSlug, "integration", options.integration)
      const name = yield* decodeId(ConnectionName, "connection", options.name)
      yield* integrations.removeConnection({ owner, integration, name })
    })),
    ensure: async (integration, connectionName) => {
      const existing = await list()
      if (
        existing.some((connection) =>
          connection.integration === integration.slug && connection.name === connectionName
        )
      ) {
        return true
      }
      const noAuth = integration.authMethods.find((method) => method.kind === "none")
      if (noAuth === undefined && integration.authMethods.length > 0) return false
      await create({
        integration: integration.slug,
        name: connectionName,
        template: noAuth?.template ?? "none",
        value: ""
      })
      return true
    }
  }
}

const buildTools = (host: HostHandle): ToolsApi => ({
  list: (filter: ToolQuery = {}) => host.run(Effect.gen(function* () {
    const integrations = yield* IntegrationHost
    return yield* integrations.listTools(yield* decodeToolQuery(filter))
  })),
  summaries: (filter: ToolQuery = {}) => host.run(Effect.gen(function* () {
    const integrations = yield* IntegrationHost
    return yield* integrations.toolSummaries(yield* decodeToolQuery(filter))
  })),
  describe: (target) => host.run(Effect.gen(function* () {
    const integrations = yield* IntegrationHost
    if (Predicate.isString(target)) return yield* integrations.describeTool(target)
    const integration = yield* decodeId(IntegrationSlug, "integration", target.integration)
    const connection = target.connection === undefined
      ? undefined
      : yield* decodeId(ConnectionName, "connection", target.connection)
    return yield* integrations.describeTool({
      integration,
      name: target.name,
      ...whenPresent("connection", connection)
    })
  })),
  execute: (address, input) => host.run(Effect.gen(function* () {
    const integrations = yield* IntegrationHost
    return yield* integrations.execute(address, input)
  }))
})

const buildAuth = (host: HostHandle): AuthApi => ({
  probe: (url) => host.run(Effect.gen(function* () {
    const oauth = yield* OAuthFlows
    return yield* oauth.probe(url)
  })),
  registerClient: (options) => host.run(Effect.gen(function* () {
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
      ...whenPresent(
        "tokenAuthMethods",
        options.tokenEndpointAuthMethodsSupported
      )
    })
  })),
  createClient: (options) => host.run(Effect.gen(function* () {
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
  })),
  start: (options) => host.run(Effect.gen(function* () {
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
    return yield* Schema.decodeUnknownEffect(OAuthStart)({
      status: "redirect",
      authorizationUrl: started.authorizationUrl,
      state: started.state
    })
  })),
  /** Finishing a flow both exchanges the code and files the connection the
   * tokens belong to. A binding without that connection would be unaddressable,
   * so the two have to happen together. */
  complete: (options) => host.run(Effect.gen(function* () {
    const integrations = yield* IntegrationHost
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
    // The grant is exchanged, sealed and filed by this point, so the account is
    // connected whatever happens next. Reading the tool list is a separate
    // conversation with the vendor, and letting its failure fail the flow tells
    // someone who just authorized in a browser that they did not — while the
    // connection it denies sits in the catalog. The overview reports a capture
    // that did not work as `toolError`, which is where a reader looks for it.
    yield* Effect.ignore(integrations.refreshConnection({
      owner: record.owner,
      integration: record.integration,
      name: record.name
    }))
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
      status: "connected"
    })
  }))
})

export interface IntegrationsApi {
  readonly catalog: CatalogApi
  readonly connections: ConnectionsApi
  readonly auth: AuthApi
  readonly tools: ToolsApi
  readonly provisioning: ReturnType<typeof createIntegrationProvisioning>
  readonly validateIntegrationNode: ReturnType<typeof createIntegrationValidation>
  readonly listIntegrationOverviews: ReturnType<typeof createIntegrationOverview>
}

/** Every capability of one host, as Promises. */
export const createIntegrationsApi = (host: HostHandle): IntegrationsApi => {
  const catalog = buildCatalog(host)
  const connections = buildConnections(host)
  const tools = buildTools(host)
  const auth = buildAuth(host)

  return {
    catalog,
    connections,
    auth,
    tools,
    provisioning: createIntegrationProvisioning({
      catalog,
      connections,
      tools
    }),
    validateIntegrationNode: createIntegrationValidation({ tools }),
    listIntegrationOverviews: createIntegrationOverview({ catalog, connections, tools })
  }
}

/** The whole capability, derived from a host already in the context. */
export class IntegrationsApiService extends Context.Service<
  IntegrationsApiService,
  IntegrationsApi
>()("@mokronos/integrations/IntegrationsApi") {
  static readonly layerNoDeps: Layer.Layer<
    IntegrationsApiService,
    never,
    HostHandleService
  > = Layer.effect(
    IntegrationsApiService,
    Effect.gen(function* () {
      const host = yield* HostHandleService
      return createIntegrationsApi(host)
    })
  )

  static readonly layer = (
    directory: string,
    storage?: Parameters<typeof HostHandleService.layer>[1]
  ): Layer.Layer<IntegrationsApiService> =>
    this.layerNoDeps.pipe(Layer.provide(HostHandleService.layer(directory, storage)))

  /** Exposes the host too, for a composition root that reports lifecycle as
   *  well as using the services. */
  static readonly layerWithHost = (
    directory: string,
    storage?: Parameters<typeof HostHandleService.layer>[1]
  ): Layer.Layer<IntegrationsApiService | HostHandleService> =>
    this.layerNoDeps.pipe(
      Layer.provideMerge(HostHandleService.layer(directory, storage))
    )
}
