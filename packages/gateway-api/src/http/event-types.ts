import { Effect } from "effect"
import { NotFound, whenPresent } from "@integragents/contracts"
import type { EventPoll, EventPollResult, EventType, IntegrationError, ProfileEventType } from "@integragents/contracts"
import type { Alias } from "@integragents/contracts"
import { Integrations } from "@integragents/integrations"
import { capture } from "./observability.ts"
import { asCallerFailure } from "./operations.ts"
import type { GatewayOperationServices } from "./operations.ts"
import type { ProfileConnection } from "./resources.ts"

const underAlias = (alias: Alias, eventType: EventType): ProfileEventType => ({
  alias,
  name: eventType.name,
  description: eventType.description,
  delivery: eventType.delivery,
  ...whenPresent("inputSchema", eventType.inputSchema),
  ...whenPresent("payloadSchema", eventType.payloadSchema),
  ...whenPresent("meta", eventType.meta)
})

/**
 * The event types (MCP Events) of every connection the profile reaches, from
 * the catalog, under each connection's alias. Reading them asks no server.
 */
export const listProfileEventTypes = (connections: ReadonlyArray<ProfileConnection>) =>
  Effect.gen(function* () {
    const integrations = yield* Integrations
    const listed = yield* Effect.forEach(connections, (connection) =>
      capture(
        integrations.listEventTypes({
          integration: connection.reference.integration,
          owner: connection.reference.owner,
          connection: connection.reference.name
        })
      ).pipe(Effect.map((eventTypes) => eventTypes.map((eventType) => underAlias(connection.alias, eventType))))
    )
    return listed.flat()
  })

/** One `events/poll` on the connection `alias` names, with that connection's credential. */
export const pollProfileEvents = (
  connections: ReadonlyArray<ProfileConnection>,
  alias: Alias,
  poll: EventPoll
): Effect.Effect<EventPollResult, IntegrationError, GatewayOperationServices> =>
  Effect.gen(function* () {
    const connection = connections.find((candidate) => candidate.alias === alias)
    if (connection === undefined) {
      return yield* new NotFound({
        resource: "connection",
        id: alias,
        known: connections.map((candidate) => candidate.alias)
      })
    }
    const integrations = yield* Integrations
    return yield* asCallerFailure(integrations.pollEvents(connection.reference, poll), connection.reference.integration)
  })
