import { Effect, Option } from "effect"
import type {
  ConnectionName,
  ConnectionOwner,
  IntegrationSlug,
  ResourceContents,
  ResourceEntry,
  SkillEntry
} from "@integragents/contracts"
import { McpClient } from "../mcp/client.ts"
import { mcpCredential, requireMcpServer } from "./access.ts"
import type { ConnectionAccess, IntegrationFailure } from "./access.ts"

export interface ConnectionReference {
  readonly owner: ConnectionOwner
  readonly integration: IntegrationSlug
  readonly name: ConnectionName
}

/**
 * A connection's resources, read from its MCP server with the connection's
 * own credential. Other kinds of integration serve none.
 */
export const resourceMethods = (access: ConnectionAccess) =>
  Effect.gen(function* () {
    const mcp = yield* McpClient
    const { requireIntegration, requireConnection, withCredential } = access

    const listResources = Effect.fn("Integrations.listResources")(function* (
      reference: ConnectionReference
    ): Effect.fn.Return<ReadonlyArray<ResourceEntry>, IntegrationFailure> {
      const integration = yield* requireIntegration(reference.integration)
      if (integration.kind !== "mcp") return []
      const connection = yield* requireConnection(reference)
      const server = yield* requireMcpServer(integration)
      return yield* withCredential(integration, connection, (credential) =>
        mcp.listResources(server, mcpCredential(credential))
      )
    })

    const readResource = Effect.fn("Integrations.readResource")(function* (
      reference: ConnectionReference,
      uri: string
    ): Effect.fn.Return<ReadonlyArray<ResourceContents>, IntegrationFailure> {
      const integration = yield* requireIntegration(reference.integration)
      const connection = yield* requireConnection(reference)
      const server = yield* requireMcpServer(integration)
      return yield* withCredential(integration, connection, (credential) =>
        mcp.readResource(server, mcpCredential(credential), uri)
      )
    })

    const listSkills = Effect.fn("Integrations.listSkills")(function* (
      reference: ConnectionReference
    ): Effect.fn.Return<ReadonlyArray<SkillEntry>, IntegrationFailure> {
      const integration = yield* requireIntegration(reference.integration)
      if (integration.kind !== "mcp") return []
      const connection = yield* requireConnection(reference)
      const server = yield* requireMcpServer(integration)
      return yield* withCredential(integration, connection, (credential) =>
        mcp.listSkills(server, mcpCredential(credential))
      )
    })

    const getSkill = Effect.fn("Integrations.getSkill")(function* (
      reference: ConnectionReference,
      uri: string
    ): Effect.fn.Return<Option.Option<SkillEntry>, IntegrationFailure> {
      const integration = yield* requireIntegration(reference.integration)
      if (integration.kind !== "mcp") return Option.none()
      const connection = yield* requireConnection(reference)
      const server = yield* requireMcpServer(integration)
      return yield* withCredential(integration, connection, (credential) =>
        mcp.getSkill(server, mcpCredential(credential), uri)
      )
    })

    return { listResources, readResource, listSkills, getSkill }
  })
