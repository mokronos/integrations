import { Clock, Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import {
  findAuthMethod,
  mcpAuthMethods,
  openApiAuthMethods
} from "./catalog/auth-methods.ts"
import { CatalogStore } from "./catalog/store.ts"
import type { ConnectionRecord, IntegrationRecord } from "./catalog/store.ts"
import { connectionCredentialKey, CredentialStore } from "./storage/credentials.ts"
import {
  ConnectionNotFoundError,
  DetectionError,
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
import { connectionAddress, ConnectionName, IntegrationSlug, parseToolAddress, slugify, toolAddress, ToolName } from "@mokronos/contracts"
import { AuthTemplateSlug } from "./catalog/ids.ts"
import { McpHost } from "./mcp/client.ts"
import type { McpCredential } from "./mcp/client.ts"
import { OAuthFlows } from "./oauth/flows.ts"
import { OpenApiInvoker } from "./openapi/invoke.ts"
import type { ResolvedCredential } from "./openapi/invoke.ts"
import type { CompiledOperation } from "./openapi/compile.ts"
import { whenPresent } from "@mokronos/contracts"
import {
  Connection,
  EndpointDetection,
  Integration,
  OwnerTier,
  Tool,
  ToolAddress,
  ToolSummary
} from "@mokronos/contracts"
import { SpecCache } from "./openapi/cache.ts"
import { normalizeOutputSchema, normalizeToolResult } from "./mcp/result.ts"

/** The one place both halves of the host meet.
 *
 *  An MCP endpoint and an OpenAPI document are nothing alike, but a caller
 *  addressing `tools.<integration>.<owner>.<connection>.<tool>` should not have
 *  to know which it got. Everything above this service — the gateway, the CLI,
 *  the dashboard — sees one catalog, one kind of connection, and one way to
 *  call a tool. */

type Json = typeof Schema.Json.Type

export type HostFailure =
  | StorageError
  | IntegrationNotFoundError
  | ConnectionNotFoundError
  | ToolNotFoundError
  | InvocationError
  | SpecError
  | McpError
  | OAuthError
  | DetectionError
  | InvalidInputError

export interface ToolFilter {
  readonly integration?: IntegrationSlug
  readonly owner?: OwnerTier
  readonly connection?: ConnectionName
}

/** Either a tool's address, or the integration plus tool name a caller reads
 *  off a listing. */
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

/** The projection of a stored integration onto the wire shape. */
const toIntegration = (
  record: IntegrationRecord
): Effect.Effect<Integration, StorageError> =>
  Schema.decodeUnknownEffect(Integration)({
    slug: record.slug,
    name: record.name,
    description: record.description,
    kind: record.kind,
    // Every integration in this catalog was installed by an operator, so every
    // one of them can be removed and refreshed. The SDK's built-ins, which
    // could not, no longer exist.
    canRemove: true,
    canRefresh: true,
    authMethods: record.authMethods,
    ...whenPresent("displayUrl", record.displayUrl ?? record.endpoint ?? record.specSource)
  }).pipe(Effect.mapError((cause) =>
    new StorageError({ message: `Could not describe integration ${record.slug}`, cause })
  ))

const toConnection = (
  record: ConnectionRecord
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
    expiresAt: record.expiresAt ?? null
  }).pipe(Effect.mapError((cause) =>
    new StorageError({ message: `Could not describe connection ${record.name}`, cause })
  ))

/** A newly-created grant's starting policy.
 *
 *  `allow` is reserved for a tool whose own source declares it read-only. For
 *  MCP that is `readOnlyHint`; for OpenAPI it is a safe HTTP method, which is a
 *  stronger claim than any annotation because it is defined by the protocol
 *  rather than asserted by the vendor.
 *
 *  Everything else needs a human. A source with nothing to declare therefore
 *  gets `require_approval` throughout, which is the direction to fail in: an
 *  operator can widen a grant, but a call that already happened cannot be
 *  narrowed. */
const defaultDecision = (readOnly: boolean): "allow" | "require_approval" =>
  readOnly ? "allow" : "require_approval"

export class IntegrationHost extends Context.Service<
  IntegrationHost,
  {
    readonly listIntegrations: () => Effect.Effect<
      ReadonlyArray<Integration>,
      StorageError
    >
    readonly findIntegration: (
      slug: IntegrationSlug
    ) => Effect.Effect<Option.Option<Integration>, StorageError>
    readonly detect: (
      url: string
    ) => Effect.Effect<ReadonlyArray<EndpointDetection>, never>
    readonly addMcp: (options: AddMcpOptions) => Effect.Effect<IntegrationSlug, HostFailure>
    readonly addOpenApi: (
      options: AddOpenApiOptions
    ) => Effect.Effect<IntegrationSlug, HostFailure>
    readonly removeIntegration: (
      slug: IntegrationSlug
    ) => Effect.Effect<void, StorageError>

    readonly createConnection: (
      options: CreateConnectionOptions
    ) => Effect.Effect<Connection, HostFailure>
    readonly listConnections: (
      filter?: { readonly integration?: IntegrationSlug; readonly owner?: OwnerTier }
    ) => Effect.Effect<ReadonlyArray<Connection>, StorageError>
    readonly removeConnection: (reference: {
      readonly owner: OwnerTier
      readonly integration: IntegrationSlug
      readonly name: ConnectionName
    }) => Effect.Effect<void, StorageError>

    readonly toolSummaries: (
      filter?: ToolFilter
    ) => Effect.Effect<ReadonlyArray<ToolSummary>, HostFailure>
    readonly listTools: (
      filter?: ToolFilter
    ) => Effect.Effect<ReadonlyArray<Tool>, HostFailure>
    readonly describeTool: (
      target: ToolAddress | ToolTarget
    ) => Effect.Effect<Tool, HostFailure>
    readonly execute: (
      address: ToolAddress,
      input: Json
    ) => Effect.Effect<Json, HostFailure>
  }
>()("@mokronos/integration-host/IntegrationHost") {
  static readonly layer: Layer.Layer<
    IntegrationHost,
    never,
    CatalogStore | CredentialStore | McpHost | OAuthFlows | OpenApiInvoker | SpecCache
  > = Layer.effect(
    IntegrationHost,
    Effect.gen(function* () {
      const store = yield* CatalogStore
      const credentials = yield* CredentialStore
      const mcp = yield* McpHost
      const oauth = yield* OAuthFlows
      const invoker = yield* OpenApiInvoker
      const specs = yield* SpecCache

      const requireIntegration = Effect.fn("IntegrationHost.requireIntegration")(
        function* (slug: IntegrationSlug) {
          const found = yield* store.findIntegration(slug)
          return yield* Option.match(found, {
            onNone: () => Effect.fail(new IntegrationNotFoundError({ integration: slug })),
            onSome: Effect.succeed
          })
        }
      )

      const requireConnection = Effect.fn("IntegrationHost.requireConnection")(
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

      /** The secret to present for a connection, and where to put it.
       *
       *  A `none` template resolves to nothing, which is what makes an
       *  unauthenticated integration callable without a stored credential. */
      const resolveCredential = Effect.fn("IntegrationHost.resolveCredential")(
        function* (
          integration: IntegrationRecord,
          connection: ConnectionRecord
        ) {
          const method = findAuthMethod(integration.authMethods, connection.template)
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
            return Option.map(token, (value) => ({ value, placements }))
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

      /** MCP takes its credential as a header, so a placement that names one is
       *  honoured and anything else becomes a bearer token. */
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

      const summaryOf = (options: {
        readonly integration: IntegrationSlug
        readonly owner: OwnerTier
        readonly connection: ConnectionName
        readonly name: string
        readonly description: string
        readonly readOnly: boolean
      }) =>
        Schema.decodeUnknownEffect(ToolSummary)({
          address: toolAddress({
            integration: options.integration,
            owner: options.owner,
            connection: options.connection,
            tool: ToolName.make(options.name)
          }),
          name: options.name,
          description: options.description,
          integration: options.integration,
          owner: options.owner,
          connection: options.connection,
          defaultDecision: defaultDecision(options.readOnly)
        }).pipe(Effect.mapError((cause) =>
          new StorageError({
            message: `Could not describe tool ${options.name}`,
            cause
          })
        ))

      /** Every tool one connection exposes, with schemas. */
      const toolsForConnection = Effect.fn("IntegrationHost.toolsForConnection")(
        function* (
          integration: IntegrationRecord,
          connection: ConnectionRecord
        ) {
          const credential = yield* resolveCredential(integration, connection)

          if (integration.kind === "mcp") {
            const endpoint = integration.endpoint
            if (endpoint === undefined) {
              return yield* new InvalidInputError({
                field: "integration",
                detail: `${integration.slug} records no MCP endpoint`
              })
            }
            const definitions = yield* mcp.listTools(endpoint, mcpCredential(credential))
            return yield* Effect.forEach(definitions, (definition) =>
              Effect.gen(function* () {
                const summary = yield* summaryOf({
                  integration: integration.slug,
                  owner: connection.owner,
                  connection: connection.name,
                  name: definition.name,
                  description: definition.description ?? definition.title ?? "",
                  readOnly: definition.annotations?.readOnlyHint === true
                })
                return yield* Schema.decodeUnknownEffect(Tool)({
                  ...summary,
                  ...whenPresent("inputSchema", definition.inputSchema),
                  ...whenPresent(
                    "outputSchema",
                    definition.outputSchema === undefined
                      ? undefined
                      : normalizeOutputSchema(definition.outputSchema)
                  )
                }).pipe(Effect.mapError((cause) =>
                  new StorageError({
                    message: `Could not describe tool ${definition.name}`,
                    cause
                  })
                ))
              }))
          }

          const spec = yield* specs.load(integration)
          return yield* Effect.forEach(spec.operations, (operation) =>
            Effect.gen(function* () {
              const summary = yield* summaryOf({
                integration: integration.slug,
                owner: connection.owner,
                connection: connection.name,
                name: operation.name,
                description: Option.getOrElse(
                  operation.summary,
                  () => Option.getOrElse(operation.description, () => "")
                ),
                readOnly: operation.readOnly
              })
              return yield* Schema.decodeUnknownEffect(Tool)({
                ...summary,
                inputSchema: operation.inputSchema,
                ...whenPresent(
                  "outputSchema",
                  Option.getOrUndefined(operation.outputSchema)
                ),
                ...whenPresent(
                  "schemaDefinitions",
                  Object.keys(operation.schemaDefinitions).length === 0
                    ? undefined
                    : operation.schemaDefinitions
                )
              }).pipe(Effect.mapError((cause) =>
                new StorageError({
                  message: `Could not describe tool ${operation.name}`,
                  cause
                })
              ))
            }))
        }
      )

      /** The connections a tool filter selects. */
      const matchingConnections = Effect.fn("IntegrationHost.matchingConnections")(
        function* (filter: ToolFilter) {
          return yield* store.listConnections({
            ...whenPresent("integration", filter.integration),
            ...whenPresent("owner", filter.owner),
            ...whenPresent("name", filter.connection)
          })
        }
      )

      const listTools = Effect.fn("IntegrationHost.listTools")(
        function* (filter: ToolFilter = {}) {
          const connections = yield* matchingConnections(filter)
          const grouped = yield* Effect.forEach(connections, (connection) =>
            Effect.gen(function* () {
              const integration = yield* requireIntegration(connection.integration)
              return yield* toolsForConnection(integration, connection)
            }))
          return grouped.flat()
        }
      )

      const toolSummaries = Effect.fn("IntegrationHost.toolSummaries")(
        function* (filter: ToolFilter = {}) {
          const tools = yield* listTools(filter)
          return tools.map((tool): ToolSummary => ({
            address: tool.address,
            name: tool.name,
            description: tool.description,
            integration: tool.integration,
            owner: tool.owner,
            connection: tool.connection,
            defaultDecision: tool.defaultDecision
          }))
        }
      )

      const describeTool = Effect.fn("IntegrationHost.describeTool")(
        function* (target: ToolAddress | ToolTarget) {
          if (Predicate.isString(target)) {
            const parsed = parseToolAddress(target)
            if (Option.isNone(parsed)) {
              return yield* new ToolNotFoundError({ tool: target })
            }
            const parts = parsed.value
            const tools = yield* listTools({
              integration: parts.integration,
              owner: parts.owner,
              connection: parts.connection
            })
            const match = tools.find((tool) => tool.address === target)
            if (match === undefined) {
              return yield* new ToolNotFoundError({ tool: target })
            }
            return match
          }

          const tools = yield* listTools({
            integration: target.integration,
            ...whenPresent("connection", target.connection)
          })
          const match = tools.find((tool) => tool.name === target.name)
          if (match === undefined) {
            return yield* new ToolNotFoundError({
              tool: `${target.integration}/${target.name}`
            })
          }
          return match
        }
      )

      const execute = Effect.fn("IntegrationHost.execute")(
        function* (address: ToolAddress, input: Json) {
          const parsed = parseToolAddress(address)
          if (Option.isNone(parsed)) {
            return yield* new ToolNotFoundError({ tool: address })
          }
          const parts = parsed.value
          const integration = yield* requireIntegration(parts.integration)
          const connection = yield* requireConnection({
            owner: parts.owner,
            integration: parts.integration,
            name: parts.connection
          })
          const credential = yield* resolveCredential(integration, connection)

          if (integration.kind === "mcp") {
            const endpoint = integration.endpoint
            if (endpoint === undefined) {
              return yield* new InvalidInputError({
                field: "integration",
                detail: `${integration.slug} records no MCP endpoint`
              })
            }
            // The tool name is not checked against a listing first. The
            // server is authoritative about what it exposes and answers an
            // unknown name with an error, which surfaces as a failure below —
            // whereas pre-checking would spend a `tools/list` round trip on
            // every single call to re-learn something that can change between
            // the check and the call anyway. The OpenAPI path does check,
            // because there the specification is already in hand.
            const raw = yield* mcp.callTool(
              endpoint,
              mcpCredential(credential),
              parts.tool,
              input
            )
            return yield* normalizeToolResult(parts.tool, raw)
          }

          const spec = yield* specs.load(integration)
          const operation: CompiledOperation | undefined = spec.operations.find(
            (candidate) => candidate.name === parts.tool
          )
          if (operation === undefined) {
            return yield* new ToolNotFoundError({ tool: address })
          }
          return yield* invoker.call({
            spec,
            operation,
            input,
            specSource: Option.fromNullishOr(integration.specSource),
            baseUrl: Option.fromNullishOr(integration.baseUrl),
            credential
          })
        }
      )

      /** Classifies an endpoint without changing any stored state.
       *
       *  An MCP handshake is tried first because it is decisive: a server that
       *  answers `initialize` is an MCP server. Anything else is offered as a
       *  possible specification document, which the caller confirms by asking
       *  for a preview. */
      const detect = Effect.fn("IntegrationHost.detect")(function* (url: string) {
        const probed = yield* Effect.result(mcp.probe(url))
        const detections: Array<EndpointDetection> = []
        if (probed._tag === "Success") {
          const probe = probed.success
          if (probe.connected || probe.requiresAuthentication) {
            detections.push({
              kind: "mcp",
              confidence: probe.connected ? "high" : "medium",
              endpoint: url,
              name: probe.name,
              slug: probe.slug
            })
          }
        }
        const compiled = yield* Effect.result(specs.compileUrl(url))
        if (compiled._tag === "Success") {
          const spec = compiled.success
          const name = Option.getOrElse(spec.title, () => new URL(url).hostname)
          detections.push({
            kind: "openapi",
            confidence: spec.operations.length > 0 ? "high" : "low",
            endpoint: url,
            name,
            slug: Option.getOrElse(slugify(name), () => "api")
          })
        }
        return detections
      })

      const addMcp = Effect.fn("IntegrationHost.addMcp")(function* (options: AddMcpOptions) {
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

      const addOpenApi = Effect.fn("IntegrationHost.addOpenApi")(
        function* (options: AddOpenApiOptions) {
          const spec = yield* specs.compileUrl(options.spec)
          const now = yield* Clock.currentTimeMillis
          const name = options.name ??
            Option.getOrElse(spec.title, () => new URL(options.spec).hostname)
          yield* store.putIntegration({
            slug: options.slug,
            name,
            description: options.description ??
              Option.getOrElse(spec.description, () => ""),
            kind: "openapi",
            specSource: options.spec,
            specFormat: "openapi",
            ...whenPresent("baseUrl", options.baseUrl),
            displayUrl: options.spec,
            authMethods: openApiAuthMethods(spec.securitySchemes),
            createdAt: now
          })
          return options.slug
        }
      )

      const createConnection = Effect.fn("IntegrationHost.createConnection")(
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

          // A multi-valued credential is stored as one JSON document, so a
          // rotation replaces every part of it at once.
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
          return yield* toConnection(record)
        }
      )

      const removeConnection = Effect.fn("IntegrationHost.removeConnection")(
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
          // The credential outlives the row unless it is dropped with it.
          yield* credentials.remove(connectionCredentialKey(address))
        }
      )

      return {
        listIntegrations: Effect.fn("IntegrationHost.listIntegrations")(function* () {
          const records = yield* store.listIntegrations()
          return yield* Effect.forEach(records, toIntegration)
        }),
        findIntegration: Effect.fn("IntegrationHost.findIntegration")(
          function* (slug: IntegrationSlug) {
            const found = yield* store.findIntegration(slug)
            return yield* Option.match(found, {
              onNone: () => Effect.succeed(Option.none<Integration>()),
              onSome: (record) => Effect.map(toIntegration(record), Option.some)
            })
          }
        ),
        detect,
        addMcp,
        addOpenApi,
        removeIntegration: store.removeIntegration,
        createConnection,
        listConnections: Effect.fn("IntegrationHost.listConnections")(
          function* (filter: {
            readonly integration?: IntegrationSlug
            readonly owner?: OwnerTier
          } = {}) {
            const records = yield* store.listConnections(filter)
            return yield* Effect.forEach(records, toConnection)
          }
        ),
        removeConnection,
        toolSummaries,
        listTools,
        describeTool,
        execute
      }
    })
  )
}
