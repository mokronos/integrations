import { Effect } from "effect"
import type { DetectionError, IntegrationFailure } from "@integrations/integrations"
import type { OAuthFlowError } from "@integrations/gateway-core"
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
      (failure) => Effect.fail(new ApiBadRequest({
        error: failure instanceof Error ? failure.message : String(failure)
      }))
    )
  )
