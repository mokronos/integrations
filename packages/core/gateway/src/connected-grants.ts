import type { IntegrationsApi } from "@mokronos/integration-host"
import { Effect } from "effect"
import {
  Alias,
  ConnectionName,
  IntegrationSlug,
  ToolName,
  type Client
} from "./domain.ts"
import { newGrantId } from "./keys.ts"
import { type GatewayStore, GatewayStoreError } from "./store.ts"

const aliasFor = (integration: string): Alias =>
  Alias.make(integration.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""))

export const grantConnectedTools = Effect.fn("ConnectedGrants.grantConnectedTools")(function*(input: {
  readonly store: GatewayStore
  readonly integrations: Pick<IntegrationsApi, "tools">
  readonly client: Client
  readonly integration: string
  readonly connection: string
}): Effect.fn.Return<void, GatewayStoreError> {
  const alias = aliasFor(input.integration)
  const [tools, existing] = yield* Effect.all([
    Effect.promise(() => input.integrations.tools.summaries({
      integration: input.integration,
      connection: input.connection
    })),
    input.store.listGrants(input.client.id)
  ])
  yield* Effect.forEach(
    tools.filter((tool) =>
      tool.owner === "org" &&
      tool.connection.toLowerCase() === input.connection.toLowerCase() &&
      !existing.some((grant) => grant.alias === alias && grant.tool === tool.name)
    ),
    (tool) => input.store.createGrant({
      id: newGrantId(),
      tenantId: input.client.tenantId,
      clientId: input.client.id,
      alias,
      tool: ToolName.make(tool.name),
      connection: {
        owner: "org",
        integration: IntegrationSlug.make(tool.integration),
        name: ConnectionName.make(tool.connection)
      },
      decision: "allow"
    }),
    { discard: true }
  )
})
