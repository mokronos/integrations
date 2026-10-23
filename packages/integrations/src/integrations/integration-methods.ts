import { Clock, Effect, Option } from "effect"
import { ConnectionName, InvalidInput, whenPresent } from "@integragents/contracts"
import type { ConnectionOwner, Integration, IntegrationSlug, McpProbe } from "@integragents/contracts"
import { mcpAuthMethods, openApiAuthMethods } from "../catalog/auth-methods.ts"
import { captureHostTools } from "../catalog/capture.ts"
import { AuthTemplateSlug } from "../catalog/ids.ts"
import { CatalogStore } from "../catalog/store.ts"
import { SpecError, StorageError } from "../errors.ts"
import type { HostIntegrationDefinition } from "../host-tools.ts"
import { SpecCache } from "../openapi/cache.ts"
import { resolveServer } from "../openapi/compile.ts"
import { CredentialStore, oauthClientCredentialKey } from "../storage/credentials.ts"
import { toIntegration, toTool } from "./views.ts"

export interface AddMcpOptions {
  readonly endpoint: string
  readonly name: string
  readonly slug: IntegrationSlug
  readonly probe: McpProbe
}

export interface AddOpenApiOptions {
  readonly spec: string
  readonly slug: IntegrationSlug
  readonly name?: string
  readonly description?: string
  readonly baseUrl?: string
}

const hostAuthMethod = { id: "none", label: "Run by the host", kind: "none", template: "none" } as const

const defaultHostConnection = ConnectionName.make("default")

export const integrationMethods = (
  removeConnection: (reference: {
    readonly owner: ConnectionOwner
    readonly integration: IntegrationSlug
    readonly name: ConnectionName
  }) => Effect.Effect<void, StorageError>
) =>
  Effect.gen(function* () {
    const store = yield* CatalogStore
    const credentials = yield* CredentialStore
    const specs = yield* SpecCache

    const addMcp = Effect.fn("Integrations.addMcp")(function* (options: AddMcpOptions) {
      const now = yield* Clock.currentTimeMillis
      yield* store.putIntegration({
        slug: options.slug,
        name: options.name,
        description: options.probe.instructions ?? "",
        kind: "mcp",
        endpoint: options.endpoint,
        ...whenPresent("mcpEra", options.probe.era ?? undefined),
        displayUrl: options.endpoint,
        authMethods: mcpAuthMethods(options.probe, options.endpoint),
        createdAt: now
      })
      return options.slug
    })

    const addOpenApi = Effect.fn("Integrations.addOpenApi")(function* (options: AddOpenApiOptions) {
      const spec = yield* specs.compileUrl(options.spec)
      const now = yield* Clock.currentTimeMillis
      const name = options.name ?? Option.getOrElse(spec.title, () => new URL(options.spec).hostname)
      const server = resolveServer(spec, {
        baseUrl: Option.fromNullishOr(options.baseUrl),
        specSource: Option.some(options.spec)
      })
      if (Option.isNone(server)) {
        return yield* new SpecError({
          source: options.spec,
          detail: "The document declares no server, and none was configured"
        })
      }
      yield* store.putIntegration({
        slug: options.slug,
        name,
        description: options.description ?? Option.getOrElse(spec.description, () => ""),
        kind: "openapi",
        specSource: options.spec,
        specFormat: "openapi",
        baseUrl: server.value,
        displayUrl: options.spec,
        authMethods: openApiAuthMethods(spec.securitySchemes),
        createdAt: now
      })
      return options.slug
    })

    const registerHostIntegration = Effect.fn("Integrations.registerHostIntegration")(function* (
      definition: HostIntegrationDefinition
    ) {
      const names = definition.tools.map((tool) => tool.name)
      const repeated = names.filter((name, index) => names.indexOf(name) !== index)
      if (repeated.length > 0) {
        return yield* new InvalidInput({
          field: "tools",
          problem: `${definition.slug} names ${[...new Set(repeated)].join(", ")} more than once`
        })
      }
      const existing = yield* store.findIntegration(definition.slug)
      if (Option.isSome(existing) && existing.value.kind !== "host") {
        return yield* new InvalidInput({
          field: "slug",
          problem: `${definition.slug} is already an ${existing.value.kind} integration`
        })
      }
      const now = yield* Clock.currentTimeMillis
      const name = definition.connection ?? defaultHostConnection
      const held = yield* store.listConnections({ integration: definition.slug, owner: "org", name })
      yield* store.putIntegration({
        slug: definition.slug,
        name: definition.name,
        description: definition.description ?? "",
        kind: "host",
        authMethods: [hostAuthMethod],
        createdAt: Option.match(existing, { onNone: () => now, onSome: (record) => record.createdAt })
      })
      yield* store.putConnection({
        owner: "org",
        integration: definition.slug,
        name,
        template: AuthTemplateSlug.make(hostAuthMethod.template),
        provider: "host",
        createdAt: held[0]?.createdAt ?? now
      })
      const captured = yield* captureHostTools(
        { owner: "org", integration: definition.slug, connection: name },
        definition.tools,
        now
      )
      yield* store.replaceTools({ owner: "org", integration: definition.slug, name }, captured)
      return yield* Effect.forEach(captured, toTool)
    })

    const removeIntegration = Effect.fn("Integrations.removeIntegration")(function* (slug: IntegrationSlug) {
      const connections = yield* store.listConnections({ integration: slug })
      yield* Effect.forEach(connections, (connection) =>
        removeConnection({
          owner: connection.owner,
          integration: slug,
          name: connection.name
        })
      )
      const clients = yield* store.listOAuthClients(slug)
      yield* Effect.forEach(clients, (client) =>
        credentials.remove(oauthClientCredentialKey(client.owner, client.slug))
      )
      yield* store.removeIntegration(slug)
    })

    return {
      listIntegrations: Effect.fn("Integrations.listIntegrations")(function* () {
        const records = yield* store.listIntegrations()
        return yield* Effect.forEach(records, toIntegration)
      }),
      findIntegration: Effect.fn("Integrations.findIntegration")(function* (slug: IntegrationSlug) {
        const found = yield* store.findIntegration(slug)
        return yield* Option.match(found, {
          onNone: () => Effect.succeed(Option.none<Integration>()),
          onSome: (record) => Effect.map(toIntegration(record), Option.some)
        })
      }),
      addMcp,
      addOpenApi,
      renameIntegration: store.renameIntegration,
      removeIntegration,
      registerHostIntegration
    }
  })
