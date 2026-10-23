import { Context, Effect, Layer } from "effect"
import type { Option } from "effect"
import type {
  Connection,
  ConnectionName,
  ConnectionOwner,
  InputAnswer,
  Integration,
  IntegrationSlug,
  Json,
  Tool,
  ToolAddress,
  ToolSummary
} from "@integragents/contracts"
import { CatalogStore } from "./catalog/store.ts"
import type { StorageError } from "./errors.ts"
import type { NotFound } from "@integragents/contracts"
import type { HostIntegrationDefinition, ToolCallContext } from "./host-tools.ts"
import { McpClient } from "./mcp/client.ts"
import { OAuthFlows } from "./oauth/flows.ts"
import { SpecCache } from "./openapi/cache.ts"
import { OpenApiInvoker } from "./openapi/invoke.ts"
import { CredentialStore } from "./storage/credentials.ts"
import { connectionAccess } from "./integrations/access.ts"
import type { IntegrationFailure } from "./integrations/access.ts"
import { connectionMethods } from "./integrations/connection-methods.ts"
import type { CreateConnectionOptions } from "./integrations/connection-methods.ts"
import { integrationMethods } from "./integrations/integration-methods.ts"
import type { AddMcpOptions, AddOpenApiOptions } from "./integrations/integration-methods.ts"
import { toolMethods } from "./integrations/tool-methods.ts"
import type { ToolExecution, ToolFilter, ToolTarget } from "./integrations/tool-methods.ts"

export type { IntegrationFailure } from "./integrations/access.ts"
export type { CreateConnectionOptions } from "./integrations/connection-methods.ts"
export type { AddMcpOptions, AddOpenApiOptions } from "./integrations/integration-methods.ts"
export type { ToolExecution, ToolFilter, ToolTarget } from "./integrations/tool-methods.ts"

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
    readonly describeTool: (target: ToolAddress | ToolTarget) => Effect.Effect<Tool, StorageError | NotFound>
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
>()("@integragents/integrations/Integrations") {
  static readonly layer: Layer.Layer<
    Integrations,
    never,
    CatalogStore | CredentialStore | McpClient | OAuthFlows | OpenApiInvoker | SpecCache
  > = Layer.effect(
    Integrations,
    Effect.gen(function* () {
      const access = yield* connectionAccess
      const connections = yield* connectionMethods(access)
      const integrations = yield* integrationMethods(connections.removeConnection)
      const tools = yield* toolMethods(access)
      return { ...integrations, ...connections, ...tools }
    })
  )
}
