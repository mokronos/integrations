import { Clock, Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { findAuthMethod, mcpAuthMethods, openApiAuthMethods } from "./catalog/auth-methods.ts"
import { captureHostTools, captureMcpTools, captureOpenApiTools } from "./catalog/capture.ts"
import { CatalogStore } from "./catalog/store.ts"
import type { ConnectionRecord, IntegrationRecord } from "./catalog/store.ts"
import type { Tool as IntegrationTool } from "./tool.ts"
import { connectionCredentialKey, CredentialStore, oauthClientCredentialKey } from "./storage/credentials.ts"
import {
  ConnectionNotFoundError,
  IntegrationNotFoundError,
  InvalidInputError,
  InvocationError,
  McpError,
  OAuthError,
  SpecError,
  StorageError,
  ToolNotFoundError
} from "./errors.ts"
import { gatewayOAuthClientSlug, OAuthClientSlug } from "./catalog/ids.ts"
import { connectionAddress, ConnectionName, IntegrationSlug, ToolName } from "@integragents/contracts"
import type { InputAnswer, InputRound, McpProbe } from "@integragents/contracts"
import { AuthTemplateSlug } from "./catalog/ids.ts"
import { McpClient } from "./mcp/client.ts"
import type { McpCredential, McpServer } from "./mcp/client.ts"
import { OAuthFlows } from "./oauth/flows.ts"
import { resolveServer } from "./openapi/compile.ts"
import { OpenApiInvoker } from "./openapi/invoke.ts"
import type { ResolvedCredential } from "./openapi/invoke.ts"
import { whenPresent } from "@integragents/contracts"
import { Connection, Integration, ConnectionOwner, Tool, ToolAddress, ToolSummary } from "@integragents/contracts"
import { SpecCache } from "./openapi/cache.ts"
import { normalizeToolResult } from "./mcp/result.ts"
import { declinedInputNote } from "./mcp/unrelayable-input.ts"
import { HostToolError, HostTools } from "./host-tools.ts"
import type { HostIntegrationDefinition, ToolCallContext } from "./host-tools.ts"

type Json = typeof Schema.Json.Type

/** The provider refused the credential itself, before doing anything, so asking again with a fresh token is safe. */
const rejectsCredential = (failure: IntegrationFailure): boolean =>
  (failure._tag === "McpError" && failure.reason === "unauthorized") ||
  (failure._tag === "InvocationError" && failure.status === 401)

export type IntegrationFailure =
  | StorageError
  | IntegrationNotFoundError
  | ConnectionNotFoundError
  | ToolNotFoundError
  | InvocationError
  | SpecError
  | McpError
  | OAuthError
  | InvalidInputError
  | HostToolError

/** A tool call's outcome: its result, or a round of input the tool needs first. */
export type ToolExecution =
  | { readonly kind: "complete"; readonly result: Json }
  | { readonly kind: "input-required"; readonly round: InputRound }

export interface ToolFilter {
  readonly integration?: IntegrationSlug
  readonly owner?: ConnectionOwner
  readonly connection?: ConnectionName
}

export interface ToolTarget {
  readonly integration: IntegrationSlug
  readonly name: string
  readonly connection?: ConnectionName
}

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

export interface CreateConnectionOptions {
  readonly owner: ConnectionOwner
  readonly integration: IntegrationSlug
  readonly name: ConnectionName
  readonly template: AuthTemplateSlug
  readonly value?: string
  readonly values?: Readonly<Record<string, string>>
}

const toIntegration = (record: IntegrationRecord): Effect.Effect<Integration, StorageError> =>
  Schema.decodeUnknownEffect(Integration)({
    slug: record.slug,
    name: record.name,
    description: record.description,
    kind: record.kind,
    canRemove: true,
    // The host re-registers its own integrations; there is nothing to refresh from.
    canRefresh: record.kind !== "host",
    authMethods: record.authMethods,
    ...whenPresent("displayUrl", record.displayUrl ?? record.endpoint ?? record.specSource)
  }).pipe(
    Effect.mapError((cause) => new StorageError({ message: `Could not describe integration ${record.slug}`, cause }))
  )

const toConnection = (
  record: ConnectionRecord,
  health: {
    readonly status: "connected" | "reauthorization_required"
    readonly expiresAt?: number
    readonly error?: string
  } = { status: "connected" }
): Effect.Effect<Connection, StorageError> =>
  Schema.decodeUnknownEffect(Connection)({
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
    identityLabel: record.identityLabel ?? null,
    description: record.description ?? null,
    oauthClient: record.oauthClient ?? null,
    oauthClientOwner: record.oauthClientOwner ?? null,
    oauthScope: record.oauthScope ?? null,
    missingOAuthScopes: [],
    expiresAt: health.expiresAt ?? null,
    status: health.status,
    ...whenPresent("error", health.error)
  }).pipe(
    Effect.mapError((cause) => new StorageError({ message: `Could not describe connection ${record.name}`, cause }))
  )

const toToolSummary = (record: IntegrationTool): Effect.Effect<ToolSummary, StorageError> =>
  Schema.decodeUnknownEffect(ToolSummary)({
    address: record.address,
    name: record.name,
    description: record.description,
    integration: record.integration,
    owner: record.owner,
    connection: record.connection,
    defaultDecision: defaultDecision(record.readOnly),
    readOnly: record.readOnly,
    destructive: record.destructive,
    idempotent: record.idempotent
  }).pipe(Effect.mapError((cause) => new StorageError({ message: `Could not describe tool ${record.name}`, cause })))

const toTool = (record: IntegrationTool): Effect.Effect<Tool, StorageError> =>
  Effect.flatMap(toToolSummary(record), (summary) =>
    Schema.decodeUnknownEffect(Tool)({
      ...summary,
      ...whenPresent("inputSchema", record.inputSchema),
      ...whenPresent("outputSchema", record.outputSchema)
    }).pipe(Effect.mapError((cause) => new StorageError({ message: `Could not describe tool ${record.name}`, cause })))
  )

const hostAuthMethod = { id: "none", label: "Run by the host", kind: "none", template: "none" } as const

const defaultHostConnection = ConnectionName.make("default")

const defaultDecision = (readOnly: boolean): "allow" | "require_approval" => (readOnly ? "allow" : "require_approval")

export class Integrations extends Context.Service<
  Integrations,
  {
    readonly listIntegrations: () => Effect.Effect<ReadonlyArray<Integration>, StorageError>
    readonly findIntegration: (slug: IntegrationSlug) => Effect.Effect<Option.Option<Integration>, StorageError>
    readonly addMcp: (options: AddMcpOptions) => Effect.Effect<IntegrationSlug, IntegrationFailure>
    readonly addOpenApi: (options: AddOpenApiOptions) => Effect.Effect<IntegrationSlug, IntegrationFailure>
    readonly renameIntegration: (slug: IntegrationSlug, name: string) => Effect.Effect<void, StorageError>
    readonly removeIntegration: (slug: IntegrationSlug) => Effect.Effect<void, StorageError>

    readonly createConnection: (options: CreateConnectionOptions) => Effect.Effect<Connection, IntegrationFailure>
    readonly listConnections: (filter?: {
      readonly integration?: IntegrationSlug
      readonly owner?: ConnectionOwner
    }) => Effect.Effect<ReadonlyArray<Connection>, StorageError>
    readonly removeConnection: (reference: {
      readonly owner: ConnectionOwner
      readonly integration: IntegrationSlug
      readonly name: ConnectionName
    }) => Effect.Effect<void, StorageError>
    readonly refreshConnection: (reference: {
      readonly owner: ConnectionOwner
      readonly integration: IntegrationSlug
      readonly name: ConnectionName
    }) => Effect.Effect<ReadonlyArray<Tool>, IntegrationFailure>
    readonly savedOAuthClientId: (integration: IntegrationSlug) => Effect.Effect<Option.Option<string>, StorageError>
    /** Rebuilds every OpenAPI connection's stored tools from its specification with the current compiler. */
    readonly recompileOpenApiTools: () => Effect.Effect<void, StorageError>

    /**
     * Catalogs, or re-catalogs, an integration whose tools the embedding host
     * executes through `HostTools`. Hosts call it on every start; tools no
     * longer in the definition leave the catalog.
     */
    readonly registerHostIntegration: (
      definition: HostIntegrationDefinition
    ) => Effect.Effect<ReadonlyArray<Tool>, IntegrationFailure>

    readonly toolSummaries: (filter?: ToolFilter) => Effect.Effect<ReadonlyArray<ToolSummary>, StorageError>
    readonly listTools: (filter?: ToolFilter) => Effect.Effect<ReadonlyArray<Tool>, StorageError>
    readonly describeTool: (target: ToolAddress | ToolTarget) => Effect.Effect<Tool, StorageError | ToolNotFoundError>
    /**
     * One round of a call; `answer` continues a round an earlier call ended
     * with. `context` says who the call is made for, which host tools receive.
     */
    readonly execute: (
      address: ToolAddress,
      input: Json,
      answer?: InputAnswer,
      context?: ToolCallContext
    ) => Effect.Effect<ToolExecution, IntegrationFailure>
  }
>()("@integragents/host/Integrations") {
  static readonly layer: Layer.Layer<
    Integrations,
    never,
    CatalogStore | CredentialStore | McpClient | OAuthFlows | OpenApiInvoker | SpecCache
  > = Layer.effect(
    Integrations,
    Effect.gen(function* () {
      const store = yield* CatalogStore
      const credentials = yield* CredentialStore
      const mcp = yield* McpClient
      const oauth = yield* OAuthFlows
      const invoker = yield* OpenApiInvoker
      const specs = yield* SpecCache
      const hostTools = yield* Effect.serviceOption(HostTools)

      const requireIntegration = Effect.fn("Integrations.requireIntegration")(function* (slug: IntegrationSlug) {
        const found = yield* store.findIntegration(slug)
        return yield* Option.match(found, {
          onNone: () => Effect.fail(new IntegrationNotFoundError({ integration: slug })),
          onSome: Effect.succeed
        })
      })

      const requireMcpServer = Effect.fn("Integrations.requireMcpServer")(function* (integration: IntegrationRecord) {
        if (integration.endpoint === undefined) {
          return yield* new InvalidInputError({
            field: "integration",
            detail: `${integration.slug} records no MCP endpoint`
          })
        }
        const server: McpServer = {
          endpoint: integration.endpoint,
          era: Option.fromNullishOr(integration.mcpEra)
        }
        return server
      })

      const listMcpTools = Effect.fn("Integrations.listMcpTools")(function* (
        integration: IntegrationRecord,
        credential: Option.Option<ResolvedCredential>
      ) {
        const listing = yield* mcp.listTools(yield* requireMcpServer(integration), mcpCredential(credential))
        if (integration.mcpEra !== listing.era) {
          yield* store.putIntegration({ ...integration, mcpEra: listing.era })
        }
        return listing.tools
      })

      const requireConnection = Effect.fn("Integrations.requireConnection")(function* (reference: {
        readonly owner: ConnectionOwner
        readonly integration: IntegrationSlug
        readonly name: ConnectionName
      }) {
        const found = yield* store.listConnections({
          integration: reference.integration,
          owner: reference.owner,
          name: reference.name
        })
        const record = found[0]
        if (record === undefined) {
          return yield* new ConnectionNotFoundError({
            integration: reference.integration,
            connection: reference.name
          })
        }
        return record
      })

      const resolveCredential = Effect.fn("Integrations.resolveCredential")(function* (
        integration: IntegrationRecord,
        connection: ConnectionRecord,
        renew = false
      ) {
        const method = findAuthMethod(integration.authMethods, connection.template)
        if (Option.isNone(method)) {
          return yield* new InvalidInputError({
            field: "connection",
            detail:
              `${connection.integration}/${connection.name} was authorized against the ` +
              `${connection.template} method, which ${connection.integration} no longer offers. ` +
              `Connect it again.`
          })
        }
        const placements = Option.match(method, {
          onNone: () => [],
          onSome: (found) => found.placements ?? []
        })
        const kind = Option.map(method, (found) => found.kind)

        if (Option.exists(kind, (value) => value === "none")) {
          return Option.none<ResolvedCredential>()
        }

        if (Option.exists(kind, (value) => value === "oauth")) {
          const client = connection.oauthClient
          const clientOwner = connection.oauthClientOwner
          if (client === undefined || clientOwner === undefined) {
            return yield* new InvalidInputError({
              field: "connection",
              detail: `${connection.integration}/${connection.name} is an OAuth connection with no client recorded`
            })
          }
          const token = yield* oauth.accessToken(
            {
              owner: connection.owner,
              integration: connection.integration,
              connection: connection.name,
              clientOwner,
              client: OAuthClientSlug.make(client)
            },
            { renew }
          )
          return Option.map(token, (access) => ({ value: access.value, placements }))
        }

        const address = connectionAddress({
          owner: connection.owner,
          integration: connection.integration,
          connection: connection.name
        })
        const held = yield* credentials.get(connectionCredentialKey(address))
        return Option.map(held, (value) => ({ value, placements }))
      })

      const mcpCredential = (credential: Option.Option<ResolvedCredential>): Option.Option<McpCredential> =>
        Option.map(credential, (resolved) => {
          const header = resolved.placements.find((placement) => placement.carrier === "header")
          return header === undefined
            ? { headerName: "Authorization", headerValue: `Bearer ${resolved.value}` }
            : {
                headerName: header.name,
                headerValue: `${header.prefix}${resolved.value}`
              }
        })

      const captureConnection = Effect.fn("Integrations.captureConnection")(function* (
        integration: IntegrationRecord,
        connection: ConnectionRecord
      ) {
        const credential = yield* resolveCredential(integration, connection)
        const capturedAt = yield* Clock.currentTimeMillis
        const target = {
          owner: connection.owner,
          integration: integration.slug,
          connection: connection.name
        }

        // A host integration's tools come from its registration, not from a server to ask.
        if (integration.kind === "host") {
          return yield* store.listTools({
            integration: integration.slug,
            owner: connection.owner,
            connection: connection.name
          })
        }
        const captured =
          integration.kind === "mcp"
            ? yield* captureMcpTools(target, yield* listMcpTools(integration, credential), capturedAt)
            : yield* captureOpenApiTools(target, yield* specs.load(integration), capturedAt)

        yield* store.replaceTools(
          { owner: connection.owner, integration: integration.slug, name: connection.name },
          captured
        )
        return captured
      })

      const recompileOpenApiTools = Effect.fn("Integrations.recompileOpenApiTools")(function* () {
        const integrations = (yield* store.listIntegrations()).filter((integration) => integration.kind === "openapi")
        yield* Effect.forEach(
          integrations,
          (integration) =>
            Effect.gen(function* () {
              const spec = yield* specs.load(integration)
              const connections = yield* store.listConnections({ integration: integration.slug })
              const capturedAt = yield* Clock.currentTimeMillis
              yield* Effect.forEach(
                connections,
                (connection) =>
                  Effect.flatMap(
                    captureOpenApiTools(
                      { owner: connection.owner, integration: integration.slug, connection: connection.name },
                      spec,
                      capturedAt
                    ),
                    (captured) =>
                      store.replaceTools(
                        { owner: connection.owner, integration: integration.slug, name: connection.name },
                        captured
                      )
                  ),
                { discard: true }
              )
            }).pipe(
              Effect.catchTag("SpecError", (failure) =>
                Effect.logWarning(`Kept the stored tools for ${integration.slug}: ${failure.message}`)
              )
            ),
          { discard: true }
        )
      })

      const listTools = Effect.fn("Integrations.listTools")(function* (filter: ToolFilter = {}) {
        const records = yield* store.listTools(filter)
        return yield* Effect.forEach(records, toTool)
      })

      const toolSummaries = Effect.fn("Integrations.toolSummaries")(function* (filter: ToolFilter = {}) {
        const records = yield* store.listTools(filter)
        return yield* Effect.forEach(records, toToolSummary)
      })

      const describeTool = Effect.fn("Integrations.describeTool")(function* (target: ToolAddress | ToolTarget) {
        if (Predicate.isString(target)) {
          const found = yield* store.findTool(target)
          if (Option.isNone(found)) {
            return yield* new ToolNotFoundError({ tool: target })
          }
          return yield* toTool(found.value)
        }
        const candidates = yield* store.listTools({
          integration: target.integration,
          ...whenPresent("connection", target.connection)
        })
        const match = candidates.find((candidate) => candidate.name === target.name)
        if (match === undefined) {
          return yield* new ToolNotFoundError({
            tool: `${target.integration}/${target.name}`
          })
        }
        return yield* toTool(match)
      })

      const execute = Effect.fn("Integrations.execute")(function* (
        address: ToolAddress,
        input: Json,
        answer?: InputAnswer,
        context: ToolCallContext = {}
      ): Effect.fn.Return<ToolExecution, IntegrationFailure> {
        const found = yield* store.findTool(address)
        if (Option.isNone(found)) {
          return yield* new ToolNotFoundError({ tool: address })
        }
        const tool = found.value
        const call = tool.call
        if (call.kind === "host") {
          if (Option.isNone(hostTools)) {
            return yield* new HostToolError({
              handler: call.handler,
              detail: `${tool.integration} is run by its host, and no executor for host tools is installed`
            })
          }
          const result = yield* hostTools.value.execute({
            address,
            integration: tool.integration,
            connection: tool.connection,
            tool: ToolName.make(tool.name),
            handler: call.handler,
            arguments: input,
            context
          })
          return { kind: "complete", result }
        }
        const integration = yield* requireIntegration(tool.integration)
        const connection = yield* requireConnection({
          owner: tool.owner,
          integration: tool.integration,
          name: tool.connection
        })
        const run = (credential: Option.Option<ResolvedCredential>) =>
          Effect.gen(function* (): Effect.fn.Return<ToolExecution, IntegrationFailure> {
            if (call.kind === "mcp") {
              const called = yield* mcp.callTool(
                yield* requireMcpServer(integration),
                mcpCredential(credential),
                call.tool,
                input,
                answer
              )
              if (called.kind === "input-required") return called
              const result = yield* normalizeToolResult(tool.name, called.result).pipe(
                Effect.mapError((failed) =>
                  called.declined.length === 0
                    ? failed
                    : new InvocationError({
                        code: failed.code,
                        detail: `${failed.detail}. ${declinedInputNote(called.declined)}`,
                        ...whenPresent("status", failed.status)
                      })
                )
              )
              return { kind: "complete", result }
            }

            // The document may base a single operation somewhere other than the
            // integration, so what it declared for this one wins.
            const server = call.server ?? integration.baseUrl
            if (server === undefined) {
              return yield* new InvalidInputError({
                field: "integration",
                detail: `${integration.slug} records no server to call`
              })
            }
            const result = yield* invoker.call({
              integration: integration.name,
              call,
              tool: tool.name,
              server,
              input,
              credential
            })
            return { kind: "complete", result }
          })

        const first = yield* Effect.result(run(yield* resolveCredential(integration, connection)))
        if (first._tag === "Success") return first.success
        if (connection.provider !== "oauth" || !rejectsCredential(first.failure)) {
          return yield* first.failure
        }
        const second = yield* Effect.result(run(yield* resolveCredential(integration, connection, true)))
        if (second._tag === "Success") return second.success
        if (rejectsCredential(second.failure)) {
          yield* store.requireReconnect(
            { owner: connection.owner, integration: connection.integration, name: connection.name },
            "The provider rejected the connection's token even after a refresh"
          )
        }
        return yield* second.failure
      })

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

      const createConnection = Effect.fn("Integrations.createConnection")(function* (options: CreateConnectionOptions) {
        const integration = yield* requireIntegration(options.integration)
        if (integration.kind === "host") {
          return yield* new InvalidInputError({
            field: "integration",
            detail: `${integration.slug} is run by its host, which registers its connection itself`
          })
        }
        const method = findAuthMethod(integration.authMethods, options.template)
        if (Option.isNone(method)) {
          return yield* new InvalidInputError({
            field: "template",
            detail: `${options.integration} does not offer ${options.template}`
          })
        }

        const address = connectionAddress({
          owner: options.owner,
          integration: options.integration,
          connection: options.name
        })

        const secret = options.values === undefined ? (options.value ?? "") : JSON.stringify(options.values)
        if (secret.length > 0) {
          yield* credentials.set(connectionCredentialKey(address), secret)
        }

        const now = yield* Clock.currentTimeMillis
        const record: ConnectionRecord = {
          owner: options.owner,
          integration: options.integration,
          name: options.name,
          template: options.template,
          provider: "local",
          createdAt: now
        }
        yield* store.putConnection(record)
        yield* captureConnection(integration, record)
        return yield* toConnection(record)
      })

      const registerHostIntegration = Effect.fn("Integrations.registerHostIntegration")(function* (
        definition: HostIntegrationDefinition
      ) {
        const names = definition.tools.map((tool) => tool.name)
        const repeated = names.filter((name, index) => names.indexOf(name) !== index)
        if (repeated.length > 0) {
          return yield* new InvalidInputError({
            field: "tools",
            detail: `${definition.slug} names ${[...new Set(repeated)].join(", ")} more than once`
          })
        }
        const existing = yield* store.findIntegration(definition.slug)
        if (Option.isSome(existing) && existing.value.kind !== "host") {
          return yield* new InvalidInputError({
            field: "slug",
            detail: `${definition.slug} is already an ${existing.value.kind} integration`
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

      const refreshConnection = Effect.fn("Integrations.refreshConnection")(function* (reference: {
        readonly owner: ConnectionOwner
        readonly integration: IntegrationSlug
        readonly name: ConnectionName
      }) {
        const integration = yield* requireIntegration(reference.integration)
        const connection = yield* requireConnection(reference)
        const captured = yield* captureConnection(integration, connection)
        return yield* Effect.forEach(captured, toTool)
      })

      const removeConnection = Effect.fn("Integrations.removeConnection")(function* (reference: {
        readonly owner: ConnectionOwner
        readonly integration: IntegrationSlug
        readonly name: ConnectionName
      }) {
        const address = connectionAddress({
          owner: reference.owner,
          integration: reference.integration,
          connection: reference.name
        })
        yield* store.removeConnection(reference)
        yield* credentials.remove(connectionCredentialKey(address))
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
        createConnection,
        savedOAuthClientId: Effect.fn("Integrations.savedOAuthClientId")(function* (integration: IntegrationSlug) {
          const client = yield* store.findOAuthClient({
            owner: "org",
            slug: gatewayOAuthClientSlug(integration)
          })
          return Option.map(client, (found) => found.clientId)
        }),
        listConnections: Effect.fn("Integrations.listConnections")(function* (
          filter: {
            readonly integration?: IntegrationSlug
            readonly owner?: ConnectionOwner
          } = {}
        ) {
          const records = yield* store.listConnections(filter)
          return yield* Effect.forEach(
            records,
            (record) => {
              if (record.provider !== "oauth") return toConnection(record)
              const client = record.oauthClient
              const clientOwner = record.oauthClientOwner
              if (client === undefined || clientOwner === undefined) {
                return toConnection(record, {
                  status: "reauthorization_required",
                  error: `${record.integration}/${record.name} is an OAuth connection with no client recorded`
                })
              }
              return oauth
                .accessToken({
                  owner: record.owner,
                  integration: record.integration,
                  connection: record.name,
                  clientOwner,
                  client: OAuthClientSlug.make(client)
                })
                .pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        toConnection(record, {
                          status: "reauthorization_required",
                          error: `${record.integration}/${record.name} has no OAuth grant. Connect it again.`
                        }),
                      onSome: (access) =>
                        toConnection(record, {
                          status: "connected",
                          ...whenPresent("expiresAt", access.expiresAt)
                        })
                    })
                  ),
                  Effect.catch((cause) =>
                    toConnection(record, {
                      status: "reauthorization_required",
                      error: cause.message
                    })
                  )
                )
            },
            { concurrency: "unbounded" }
          )
        }),
        removeConnection,
        refreshConnection,
        recompileOpenApiTools,
        registerHostIntegration,
        toolSummaries,
        listTools,
        describeTool,
        execute
      }
    })
  )
}
