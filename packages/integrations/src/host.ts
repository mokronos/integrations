import { Clock, Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import {
  findAuthMethod,
  mcpAuthMethods,
  openApiAuthMethods
} from "./catalog/auth-methods.ts"
import { captureMcpTools, captureOpenApiTools } from "./catalog/capture.ts"
import { CatalogStore } from "./catalog/store.ts"
import type { ConnectionRecord, IntegrationRecord } from "./catalog/store.ts"
import type { Tool as IntegrationTool } from "@mokronos/core-integrations"
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
import { connectionAddress, ConnectionName, IntegrationSlug } from "@mokronos/contracts"
import { AuthTemplateSlug } from "./catalog/ids.ts"
import { McpHost } from "./mcp/client.ts"
import type { McpCredential } from "./mcp/client.ts"
import { OAuthFlows } from "./oauth/flows.ts"
import { resolveServer } from "./openapi/compile.ts"
import { OpenApiInvoker } from "./openapi/invoke.ts"
import type { ResolvedCredential } from "./openapi/invoke.ts"
import { whenPresent } from "@mokronos/contracts"
import {
  Connection,
  Integration,
  OwnerTier,
  Tool,
  ToolAddress,
  ToolSummary
} from "@mokronos/contracts"
import { SpecCache } from "./openapi/cache.ts"
import { normalizeToolResult } from "./mcp/result.ts"

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

/** The wire shape of a captured tool. `defaultDecision` is derived here rather
 *  than stored, because it is policy rather than fact: what was captured is
 *  whether the source declares the tool read-only. */
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

/** A newly included policy tool's starting decision.
 *
 *  `allow` is reserved for a tool whose own source declares it read-only. For
 *  MCP that is `readOnlyHint`; for OpenAPI it is a safe HTTP method, which is a
 *  stronger claim than any annotation because it is defined by the protocol
 *  rather than asserted by the vendor.
 *
 *  Everything else needs a human. A source with nothing to declare therefore
 *  gets `require_approval` throughout, which is the direction to fail in: an
 *  operator can widen a policy, but a call that already happened cannot be
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
    readonly addMcp: (options: AddMcpOptions) => Effect.Effect<IntegrationSlug, HostFailure>
    readonly addOpenApi: (
      options: AddOpenApiOptions
    ) => Effect.Effect<IntegrationSlug, HostFailure>
    readonly renameIntegration: (
      slug: IntegrationSlug,
      name: string
    ) => Effect.Effect<void, StorageError>
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
    /** Re-reads what a connection exposes and replaces what was stored for it.
     *  The only thing that reaches a live endpoint. */
    readonly refreshConnection: (reference: {
      readonly owner: OwnerTier
      readonly integration: IntegrationSlug
      readonly name: ConnectionName
    }) => Effect.Effect<ReadonlyArray<Tool>, HostFailure>

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
>()("@mokronos/integrations/IntegrationHost") {
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

      const requireEndpoint = Effect.fn("IntegrationHost.requireEndpoint")(
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
          if (Option.isNone(method)) {
            // The connection names a method the integration no longer offers —
            // a vendor that added a wall, or an endpoint re-probed into a
            // different shape. Falling through from here would reach the branch
            // that presents whatever is stored under the connection's key,
            // which for an OAuth connection is the sealed token record itself:
            // a bearer token made of JSON, and a refusal that reads as if the
            // credential were wrong rather than unbuilt.
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

      /** Captures everything one connection exposes, and replaces what was
       *  stored for it.
       *
       *  Both protocols end up in the same shape here; after this point nothing
       *  downstream knows which one it was. */
      const captureConnection = Effect.fn("IntegrationHost.captureConnection")(
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

      const listTools = Effect.fn("IntegrationHost.listTools")(
        function* (filter: ToolFilter = {}) {
          const records = yield* store.listTools(filter)
          return yield* Effect.forEach(records, toTool)
        }
      )

      const toolSummaries = Effect.fn("IntegrationHost.toolSummaries")(
        function* (filter: ToolFilter = {}) {
          const records = yield* store.listTools(filter)
          return yield* Effect.forEach(records, toToolSummary)
        }
      )

      const describeTool = Effect.fn("IntegrationHost.describeTool")(
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

      const execute = Effect.fn("IntegrationHost.execute")(
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

          // The only place a protocol is still visible, on a value read from
          // the database rather than re-derived from a live endpoint.
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
          // Resolved once, here, so a call never needs the document again: a
          // relative server is only meaningful against where the document was
          // fetched from, and that is knowledge this moment has and later
          // moments do not.
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
          // Capture now: a connection whose tools have not been read yet is
          // indistinguishable from one that exposes none.
          yield* captureConnection(integration, record)
          return yield* toConnection(record)
        }
      )

      const refreshConnection = Effect.fn("IntegrationHost.refreshConnection")(
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

      /** Removing an integration removes what it was standing for.
       *
       *  Every connection goes out through `removeConnection` rather than the
       *  catalog's own cascade: the cascade is SQL, and a sealed credential
       *  does not live in the database, so the row would go and the secret
       *  would stay. */
      const removeIntegration = Effect.fn("IntegrationHost.removeIntegration")(
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
        addMcp,
        addOpenApi,
        renameIntegration: store.renameIntegration,
        removeIntegration,
        createConnection,
        listConnections: Effect.fn("IntegrationHost.listConnections")(
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
