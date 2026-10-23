import { McpServerFailed, OAuthFailed, SpecInvalid, ToolCallFailed, whenPresent } from "@integragents/contracts"
import type { DiscoveryFailed, IntegrationError, OAuthStage, RegistryUnavailable } from "@integragents/contracts"
import { fromInvocationError } from "@integragents/integrations"
import type { IntegrationFailure, OAuthError, StorageError } from "@integragents/integrations"
import type { OAuthFlowError } from "./connection-oauth/flows.ts"

/** A failure a caller can act on; storage failures are not, and leave as a trace id instead. */
export type CallerFailure =
  | Exclude<IntegrationFailure, StorageError>
  | OAuthFlowError
  | DiscoveryFailed
  | RegistryUnavailable
  | IntegrationError

const oauthStageOf = (stage: OAuthError["stage"] | OAuthFlowError["stage"]): OAuthStage => {
  switch (stage) {
    case "complete":
      return "exchange"
    case "client-required":
      return "configure"
    case "timeout":
      return "callback"
    case "configure":
    case "discover":
    case "register":
    case "start":
    case "callback":
    case "exchange":
    case "refresh":
      return stage
  }
}

/**
 * The one place a domain failure becomes what callers receive. `integration`
 * names what an OAuth failure was for, which the failure itself does not know.
 */
export const toGatewayError = (failure: CallerFailure, integration?: string): IntegrationError => {
  switch (failure._tag) {
    case "SpecError":
      return new SpecInvalid({ source: failure.source, detail: failure.detail })
    case "McpError":
      return new McpServerFailed({
        endpoint: failure.endpoint,
        reason: failure.reason,
        detail: failure.detail,
        ...whenPresent("status", failure.status)
      })
    case "OAuthError":
    case "OAuthFlowError":
      return new OAuthFailed({
        integration: integration ?? "the integration",
        stage: oauthStageOf(failure.stage),
        reason: failure.reason,
        detail: failure.detail
      })
    case "InvocationError":
      return fromInvocationError(failure, { name: integration ?? "the tool", readOnly: false })
    case "HostToolError":
      return new ToolCallFailed({
        tool: failure.handler,
        reason: "tool_error",
        detail: failure.detail,
        mayHaveWritten: false
      })
    default:
      return failure
  }
}
