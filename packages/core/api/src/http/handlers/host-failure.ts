import { Effect } from "effect"
import type { DetectionError, HostFailure } from "@mokronos/integrations"
import type { OAuthFlowError } from "@mokronos/gateway-core"
import { ApiBadRequest } from "../api.ts"
import { capture } from "../observability.ts"

/** What a host failure means to the caller who provoked it.
 *
 *  The host's failures used to arrive here as rejected promises — `reachOut`
 *  caught them, read `cause.message` off an `unknown`, and produced a 400. That
 *  was the right answer most of the time and the wrong one for the case that
 *  matters: the host's own SQLite refusing a write is not something the caller
 *  can fix by changing their request, and telling them it is sends them
 *  debugging their own URL.
 *
 *  Now that the channel is typed, the split is by tag rather than by guess.
 *  Everything named here is the caller's — an endpoint that refused, a spec that
 *  would not parse, a tool that does not exist, an argument they invented — and
 *  each of those errors already renders itself in one sentence.
 *
 *  `StorageError` is deliberately absent: it is the host's own storage failing,
 *  the same class of problem as `GatewayStoreError`, so it falls through to
 *  {@link capture} and is recorded and answered as a 500 beside it. */
export const asApiFailure = <A, E, R>(
  effect: Effect.Effect<A, E | HostFailure | OAuthFlowError | DetectionError, R>
) =>
  capture(
    Effect.catchTag(
      effect,
      [
        "IntegrationNotFoundError",
        "ConnectionNotFoundError",
        "ToolNotFoundError",
        "InvocationError",
        "SpecError",
        "McpError",
        "OAuthError",
        "InvalidInputError",
        // A URL that is neither MCP nor OpenAPI is the caller's URL.
        "DetectionError",
        // Which stage of an authorization broke — a misconfigured OAuth app, a
        // provider that refused, a human who never finished. Every one of
        // those is the caller's to act on.
        "OAuthFlowError"
      ],
      // Every member is a `Schema.TaggedError`, so each is an `Error` with the
      // one-sentence message it renders itself as. The guard is for the
      // generic: a caller's `E` is unconstrained and could carry another type
      // under one of these tags.
      (failure) => Effect.fail(new ApiBadRequest({
        error: failure instanceof Error ? failure.message : String(failure)
      }))
    )
  )
