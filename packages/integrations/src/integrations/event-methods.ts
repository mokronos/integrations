import { Effect } from "effect"
import type { Option } from "effect"
import { InvalidInput, OAuthReconnectRequired } from "@integragents/contracts"
import type {
  EventPoll,
  EventPollResult,
  EventSubscribe,
  EventSubscription,
  EventType,
  EventUnsubscribe
} from "@integragents/contracts"
import { CatalogStore } from "../catalog/store.ts"
import type { ToolFilter } from "../catalog/store.ts"
import type { StorageError } from "../errors.ts"
import { McpClient } from "../mcp/client.ts"
import type { McpCredential, McpServer } from "../mcp/client.ts"
import { mcpCredential, requireMcpServer } from "./access.ts"
import type { ConnectionAccess, IntegrationFailure } from "./access.ts"
import type { ConnectionReference } from "./resource-methods.ts"

/**
 * MCP Events on a connection: the event types its server listed, kept in the
 * catalog beside its tools, and polling and webhook subscriptions made with
 * the connection's own credential, through the same egress and OAuth refresh
 * as its tool calls.
 */
export const eventMethods = (access: ConnectionAccess) =>
  Effect.gen(function* () {
    const store = yield* CatalogStore
    const mcp = yield* McpClient
    const { requireIntegration, requireConnection, withCredential } = access

    const onConnection = <A>(
      reference: ConnectionReference,
      use: (server: McpServer, credential: Option.Option<McpCredential>) => Effect.Effect<A, IntegrationFailure>
    ): Effect.Effect<A, IntegrationFailure> =>
      Effect.gen(function* () {
        const integration = yield* requireIntegration(reference.integration)
        if (integration.kind !== "mcp") {
          return yield* new InvalidInput({
            field: "integration",
            problem: `${integration.slug} is not an MCP server, so it has no events`
          })
        }
        const connection = yield* requireConnection(reference)
        const server = yield* requireMcpServer(integration)
        return yield* withCredential(integration, connection, (credential) =>
          use(server, mcpCredential(credential))
        ).pipe(
          // As for a tool call: a grant that cannot be renewed is the person's to reconnect.
          Effect.catchTag("OAuthError", (failure): Effect.Effect<never, IntegrationFailure> =>
            Effect.fail(
              failure.reason === "reconnect_required"
                ? new OAuthReconnectRequired({ integration: reference.integration, connection: reference.name })
                : failure
            )
          )
        )
      })

    const listEventTypes = Effect.fn("Integrations.listEventTypes")(function* (
      filter: ToolFilter = {}
    ): Effect.fn.Return<ReadonlyArray<EventType>, StorageError> {
      return yield* store.listEventTypes(filter)
    })

    const pollEvents = Effect.fn("Integrations.pollEvents")(function* (
      reference: ConnectionReference,
      poll: EventPoll
    ): Effect.fn.Return<EventPollResult, IntegrationFailure> {
      yield* Effect.annotateCurrentSpan({ "mcp.event.name": poll.name })
      return yield* onConnection(reference, (server, credential) => mcp.pollEvents(server, credential, poll))
    })

    const subscribeEvents = Effect.fn("Integrations.subscribeEvents")(function* (
      reference: ConnectionReference,
      subscribe: EventSubscribe
    ): Effect.fn.Return<EventSubscription, IntegrationFailure> {
      yield* Effect.annotateCurrentSpan({ "mcp.event.name": subscribe.name })
      return yield* onConnection(reference, (server, credential) => mcp.subscribeEvents(server, credential, subscribe))
    })

    const unsubscribeEvents = Effect.fn("Integrations.unsubscribeEvents")(function* (
      reference: ConnectionReference,
      unsubscribe: EventUnsubscribe
    ): Effect.fn.Return<void, IntegrationFailure> {
      yield* Effect.annotateCurrentSpan({ "mcp.event.name": unsubscribe.name })
      return yield* onConnection(reference, (server, credential) =>
        mcp.unsubscribeEvents(server, credential, unsubscribe)
      )
    })

    return { listEventTypes, pollEvents, subscribeEvents, unsubscribeEvents }
  })
