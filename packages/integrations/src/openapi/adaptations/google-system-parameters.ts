/**
 * Google declares its system parameters on every method of every API
 * (https://cloud.google.com/apis/docs/system-parameters). These control
 * transport details the gateway owns: credentials, JSONP, error format and
 * pretty printing. `alt`, `fields` and `uploadType` stay, since media
 * downloads, partial responses and uploads depend on them.
 */
import type { OperationInput } from "../operation-inputs.ts"
import type { AdaptationContext } from "./context.ts"

const systemParameters = new Set([
  "$.xgafv",
  "access_token",
  "callback",
  "key",
  "oauth_token",
  "prettyPrint",
  "quotaUser",
  "upload_protocol"
])

const isGoogleApi = (server: string): boolean =>
  URL.canParse(server) && new URL(server).hostname.endsWith(".googleapis.com")

export const dropGoogleSystemParameters = (
  inputs: ReadonlyArray<OperationInput>,
  context: AdaptationContext
): ReadonlyArray<OperationInput> =>
  context.servers.some(isGoogleApi)
    ? inputs.filter((input) =>
      input.kind === "body" ||
      input.parameter.location !== "query" ||
      !systemParameters.has(input.parameter.name)
    )
    : inputs
