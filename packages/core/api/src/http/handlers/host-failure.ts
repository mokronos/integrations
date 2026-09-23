import { Effect } from "effect"
import type { DetectionError, IntegrationFailure } from "@integragents/host"
import type { OAuthFlowError } from "@integragents/gateway-core"
import { ApiBadRequest } from "../api.ts"
import { capture } from "../observability.ts"

export const asApiFailure = <A, E, R>(
  effect: Effect.Effect<A, E | IntegrationFailure | OAuthFlowError | DetectionError, R>
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
        "DetectionError",
        "OAuthFlowError"
      ],
      (failure) => {
        const message = failure instanceof Error ? failure.message : String(failure)
        return Effect.logInfo(`Request refused: ${message}`).pipe(
          Effect.annotateLogs({ "error.tag": failure._tag }),
          Effect.andThen(Effect.fail(new ApiBadRequest({ error: message })))
        )
      }
    )
  )
