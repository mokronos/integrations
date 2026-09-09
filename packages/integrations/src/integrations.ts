import { Clock, Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import {
  findAuthMethod,
  mcpAuthMethods,
  openApiAuthMethods
} from "./catalog/auth-methods.ts"
import { captureMcpTools, captureOpenApiTools } from "./catalog/capture.ts"
import { CatalogStore } from "./catalog/store.ts"
import type { ConnectionRecord, IntegrationRecord } from "./catalog/store.ts"
import type { Tool as IntegrationTool } from "./tool.ts"
import { connectionCredentialKey, CredentialStore } from "./storage/credentials.ts"
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
import { OAuthClientSlug } from "./catalog/ids.ts"
import { connectionAddress, ConnectionName, IntegrationSlug } from "@integrations/contracts"
import { AuthTemplateSlug } from "./catalog/ids.ts"
import { McpClient } from "./mcp/client.ts"
import type { McpCredential } from "./mcp/client.ts"
import { OAuthFlows } from "./oauth/flows.ts"
import { resolveServer } from "./openapi/compile.ts"
import { OpenApiInvoker } from "./openapi/invoke.ts"
import type { ResolvedCredential } from "./openapi/invoke.ts"
import { whenPresent } from "@integrations/contracts"
import {
  Connection,
  Integration,
  OwnerTier,
  Tool,
  ToolAddress,
  ToolSummary
} from "@integrations/contracts"
import { SpecCache } from "./openapi/cache.ts"
import { normalizeToolResult } from "./mcp/result.ts"

type Json = typeof Schema.Json.Type

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

export interface ToolFilter {
  readonly integration?: IntegrationSlug
  readonly owner?: OwnerTier
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
}

export interface AddOpenApiOptions {
  readonly spec: string
  readonly slug: IntegrationSlug
  readonly name?: string
  readonly description?: string
  readonly baseUrl?: string
}

export interface CreateConnectionOptions {
  readonly owner: OwnerTier
  readonly integration: IntegrationSlug
  readonly name: ConnectionName
  readonly template: AuthTemplateSlug
  readonly value?: string
  readonly values?: Readonly<Record<string, string>>
}

const toIntegration = (
  record: IntegrationRecord
): Effect.Effect<Integration, StorageError> =>
  Schema.decodeUnknownEffect(Integration)({
    slug: record.slug,
    name: record.name,
    description: record.description,
    kind: record.kind,
    canRemove: true,
    canRefresh: true,
    authMethods: record.authMethods,
    ...whenPresent("displayUrl", record.displayUrl ?? record.endpoint ?? record.specSource)
  }).pipe(Effect.mapError((cause) =>
    new StorageError({ message: `Could not describe integration ${record.slug}`, cause })
  ))

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
    expiresAt: health.expiresAt ?? record.expiresAt ?? null,
    status: health.status,
    ...whenPresent("error", health.error)
  }).pipe(Effect.mapError((cause) =>
    new StorageError({ message: `Could not describe connection ${record.name}`, cause })
  ))

const toToolSummary = (
  record: IntegrationTool
): Effect.Effect<ToolSummary, StorageError> =>
  Schema.decodeUnknownEffect(ToolSummary)({
    address: record.address,
    name: record.name,
    description: record.description,
    integration: record.integration,
    owner: record.owner,
    connection: record.connection,
    defaultDecision: defaultDecision(record.readOnly)
  }).pipe(Effect.mapError((cause) =>
    new StorageError({ message: `Could not describe tool ${record.name}`, cause })
  ))

const toTool = (record: IntegrationTool): Effect.Effect<Tool, StorageError> =>
  Effect.flatMap(toToolSummary(record), (summary) =>
    Schema.decodeUnknownEffect(Tool)({
      ...summary,
      ...whenPresent("inputSchema", record.inputSchema),
      ...whenPresent("outputSchema", record.outputSchema)
    }).pipe(Effect.mapError((cause) =>
      new StorageError({ message: `Could not describe tool ${record.name}`, cause })
    )))

const defaultDecision = (readOnly: boolean): "allow" | "require_approval" =>
  readOnly ? "allow" : "require_approval"

export class Integrations extends Context.Service<
  Integrations,
  {
    readonly listIntegrations: () => Effect.Effect<
      ReadonlyArray<Integration>,
      StorageError
    >
    readonly findIntegration: (
      slug: IntegrationSlug
    ) => Effect.Effect<Option.Option<Integration>, StorageError>
    readonly addMcp: (options: AddMcpOptions) => Effect.Effect<IntegrationSlug, IntegrationFailure>
    readonly addOpenApi: (
      options: AddOpenApiOptions
    ) => Effect.Effect<IntegrationSlug, IntegrationFailure>
    readonly renameIntegration: (
      slug: IntegrationSlug,
      name: string
    ) => Effect.Effect<void, StorageError>
    readonly removeIntegration: (
      slug: IntegrationSlug
    ) => Effect.Effect<void, StorageError>

    readonly createConnection: (
      options: CreateConnectionOptions
    ) => Effect.Effect<Connection, IntegrationFailure>
    readonly listConnections: (
      filter?: { readonly integration?: IntegrationSlug; readonly owner?: OwnerTier }
    ) => Effect.Effect<ReadonlyArray<Connection>, StorageError>
    readonly removeConnection: (reference: {
      readonly owner: OwnerTier
      readonly integration: IntegrationSlug
      readonly name: ConnectionName
    }) => Effect.Effect<void, StorageError>
    readonly refreshConnection: (reference: {
      readonly owner: OwnerTier
      readonly integration: IntegrationSlug
      readonly name: ConnectionName
    }) => Effect.Effect<ReadonlyArray<Tool>, IntegrationFailure>

    readonly toolSummaries: (
      filter?: ToolFilter
    ) => Effect.Effect<ReadonlyArray<ToolSummary>, StorageError>
    readonly listTools: (
      filter?: ToolFilter
    ) => Effect.Effect<ReadonlyArray<Tool>, StorageError>
    readonly describeTool: (
      target: ToolAddress | ToolTarget
    ) => Effect.Effect<Tool, StorageError | ToolNotFoundError>
    readonly execute: (
      address: ToolAddress,
      input: Json
    ) => Effect.Effect<Json, IntegrationFailure>
  }
>()("@integrations/integrations/Integrations") {
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

      const requireIntegration = Effect.fn("Integrations.requireIntegration")(
        function* (slug: IntegrationSlug) {
          const found = yield* store.findIntegration(slug)
          return yield* Option.match(found, {
            onNone: () => Effect.fail(new IntegrationNotFoundError({ integration: slug })),
            onSome: Effect.succeed
          })
        }
      )

      const requireEndpoint = Effect.fn("Integrations.requireEndpoint")(
        function* (integration: IntegrationRecord) {
          if (integration.endpoint === undefined) {
            return yield* new InvalidInputError({
              field: "integration",
              detail: `${integration.slug} records no MCP endpoint`
            })
          }
          return integration.endpoint
        }
      )

      const requireConnection = Effect.fn("Integrations.requireConnection")(
        function* (reference: {
          readonly owner: OwnerTier
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
        }
      )

      const resolveCredential = Effect.fn("Integrations.resolveCredential")(
        function* (
          integration: IntegrationRecord,
          connection: ConnectionRecord
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
            const token = yield* oauth.accessToken({
              owner: connection.owner,
              integration: connection.integration,
              connection: connection.name,
              clientOwner,
              client: OAuthClientSlug.make(client)
            })
            return Option.map(token, (access) => ({ value: access.value, placements }))
          }

          const address = connectionAddress({
            owner: connection.owner,
            integration: connection.integration,
            connection: connection.name
          })
          const held = yield* credentials.get(connectionCredentialKey(address))
          return Option.map(held, (value) => ({ value, placements }))
        }
      )

      const mcpCredential = (
        credential: Option.Option<ResolvedCredential>
      ): Option.Option<McpCredential> =>
        Option.map(credential, (resolved) => {
          const header = resolved.placements.find(
            (placement) => placement.carrier === "header"
          )
          return header === undefined
            ? { headerName: "Authorization", headerValue: `Bearer ${resolved.value}` }
            : {
              headerName: header.name,
              headerValue: `${header.prefix}${resolved.value}`
            }
        })

      const captureConnection = Effect.fn("Integrations.captureConnection")(
        function* (integration: IntegrationRecord, connection: ConnectionRecord) {
          const credential = yield* resolveCredential(integration, connection)
          const capturedAt = yield* Clock.currentTimeMillis
          const target = {
            owner: connection.owner,
            integration: integration.slug,
            connection: connection.name
          }

          const captured = integration.kind === "mcp"
            ? yield* captureMcpTools(
              target,
              yield* mcp.listTools(
                yield* requireEndpoint(integration),
                mcpCredential(credential)
              ),
              capturedAt
            )
            : yield* captureOpenApiTools(
              target,
              yield* specs.load(integration),
              capturedAt
            )

          yield* store.replaceTools(
            { owner: connection.owner, integration: integration.slug, name: connection.name },
            captured
          )
          return captured
        }
      )

      const listTools = Effect.fn("Integrations.listTools")(
        function* (filter: ToolFilter = {}) {
          const records = yield* store.listTools(filter)
          return yield* Effect.forEach(records, toTool)
        }
      )

      const toolSummaries = Effect.fn("Integrations.toolSummaries")(
        function* (filter: ToolFilter = {}) {
          const records = yield* store.listTools(filter)
          return yield* Effect.forEach(records, toToolSummary)
        }
      )

      const describeTool = Effect.fn("Integrations.describeTool")(
        function* (target: ToolAddress | ToolTarget) {
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
        }
      )

      const execute = Effect.fn("Integrations.execute")(
        function* (address: ToolAddress, input: Json) {
          const found = yield* store.findTool(address)
          if (Option.isNone(found)) {
            return yield* new ToolNotFoundError({ tool: address })
          }
          const tool = found.value
          const integration = yield* requireIntegration(tool.integration)
          const connection = yield* requireConnection({
            owner: tool.owner,
            integration: tool.integration,
            name: tool.connection
          })
          const credential = yield* resolveCredential(integration, connection)

          if (tool.call.kind === "mcp") {
            const raw = yield* mcp.callTool(
              yield* requireEndpoint(integration),
              mcpCredential(credential),
              tool.call.tool,
              input
            )
            return yield* normalizeToolResult(tool.name, raw)
          }

          const server = integration.baseUrl
          if (server === undefined) {
            return yield* new InvalidInputError({
              field: "integration",
              detail: `${integration.slug} records no server to call`
            })
          }
          return yield* invoker.call({
            call: tool.call,
            tool: tool.name,
            server,
            input,
            credential
          })
        }
      )

      const addMcp = Effect.fn("Integrations.addMcp")(function* (options: AddMcpOptions) {
        const probe = yield* mcp.probe(options.endpoint)
        const now = yield* Clock.currentTimeMillis
        yield* store.putIntegration({
          slug: options.slug,
          name: options.name,
          description: probe.instructions ?? "",
          kind: "mcp",
          endpoint: options.endpoint,
          displayUrl: options.endpoint,
          authMethods: mcpAuthMethods(probe, options.endpoint),
          createdAt: now
        })
        return options.slug
      })

      const addOpenApi = Effect.fn("Integrations.addOpenApi")(
        function* (options: AddOpenApiOptions) {
          const spec = yield* specs.compileUrl(options.spec)
          const now = yield* Clock.currentTimeMillis
          const name = options.name ??
            Option.getOrElse(spec.title, () => new URL(options.spec).hostname)
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
            description: options.description ??
              Option.getOrElse(spec.description, () => ""),
            kind: "openapi",
            specSource: options.spec,
            specFormat: "openapi",
            baseUrl: server.value,
            displayUrl: options.spec,
            authMethods: openApiAuthMethods(spec.securitySchemes),
            createdAt: now
          })
          return options.slug
        }
      )

      const createConnection = Effect.fn("Integrations.createConnection")(
        function* (options: CreateConnectionOptions) {
          const integration = yield* requireIntegration(options.integration)
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

          const secret = options.values === undefined
            ? options.value ?? ""
            : JSON.stringify(options.values)
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
        }
      )

      const refreshConnection = Effect.fn("Integrations.refreshConnection")(
        function* (reference: {
          readonly owner: OwnerTier
          readonly integration: IntegrationSlug
          readonly name: ConnectionName
        }) {
          const integration = yield* requireIntegration(reference.integration)
          const connection = yield* requireConnection(reference)
          const captured = yield* captureConnection(integration, connection)
          return yield* Effect.forEach(captured, toTool)
        }
      )

      const removeConnection = Effect.fn("Integrations.removeConnection")(
        function* (reference: {
          readonly owner: OwnerTier
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
        }
      )

      const removeIntegration = Effect.fn("Integrations.removeIntegration")(
        function* (slug: IntegrationSlug) {
          const connections = yield* store.listConnections({ integration: slug })
          yield* Effect.forEach(connections, (connection) =>
            removeConnection({
              owner: connection.owner,
              integration: slug,
              name: connection.name
            }))
          yield* store.removeIntegration(slug)
        }
      )

      return {
        listIntegrations: Effect.fn("Integrations.listIntegrations")(function* () {
          const records = yield* store.listIntegrations()
          return yield* Effect.forEach(records, toIntegration)
        }),
        findIntegration: Effect.fn("Integrations.findIntegration")(
          function* (slug: IntegrationSlug) {
            const found = yield* store.findIntegration(slug)
            return yield* Option.match(found, {
              onNone: () => Effect.succeed(Option.none<Integration>()),
              onSome: (record) => Effect.map(toIntegration(record), Option.some)
            })
          }
        ),
        addMcp,
        addOpenApi,
        renameIntegration: store.renameIntegration,
        removeIntegration,
        createConnection,
        listConnections: Effect.fn("Integrations.listConnections")(
          function* (filter: {
            readonly integration?: IntegrationSlug
            readonly owner?: OwnerTier
          } = {}) {
            const records = yield* store.listConnections(filter)
            return yield* Effect.forEach(records, (record) => {
              if (record.provider !== "oauth") return toConnection(record)
              const client = record.oauthClient
              const clientOwner = record.oauthClientOwner
              if (client === undefined || clientOwner === undefined) {
                return toConnection(record, {
                  status: "reauthorization_required",
                  error: `${record.integration}/${record.name} is an OAuth connection with no client recorded`
                })
              }
              return oauth.accessToken({
                owner: record.owner,
                integration: record.integration,
                connection: record.name,
                clientOwner,
                client: OAuthClientSlug.make(client)
              }).pipe(
                Effect.flatMap(Option.match({
                  onNone: () => toConnection(record, {
                    status: "reauthorization_required",
                    error: `${record.integration}/${record.name} has no OAuth grant. Connect it again.`
                  }),
                  onSome: (access) => toConnection(record, {
                    status: "connected",
                    ...whenPresent("expiresAt", access.expiresAt)
                  })
                })),
                Effect.catch((cause) => toConnection(record, {
                  status: "reauthorization_required",
                  error: cause.message
                }))
              )
            }, { concurrency: "unbounded" })
          }
        ),
        removeConnection,
        refreshConnection,
        toolSummaries,
        listTools,
        describeTool,
        execute
      }
    })
  )
}
