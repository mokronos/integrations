import { Option } from "effect"
import { isJsonObject, type Json } from "@mokronos/contracts"
import type { HttpCall } from "@mokronos/core-integrations"

/** Splitting a caller's flat arguments back into the parts a request is made
 *  of.
 *
 *  The inverse of the flattening done at capture, driven by the same location
 *  map — which is stored on the call, so this needs neither the specification
 *  nor the compiled operation it came from. */

export interface SplitArguments {
  readonly parameters: Record<string, Json>
  readonly requestBody: Option.Option<Json>
  /** Properties the operation does not declare.
   *
   *  Reported rather than forwarded. Routing an unrecognised property to the
   *  query string — the obvious default, since most parameters live there —
   *  means a caller that invents an argument silently sends it upstream, which
   *  is how a typo becomes a filter nobody asked for. */
  readonly unknown: ReadonlyArray<string>
}

export const splitArguments = (call: HttpCall, input: Json): SplitArguments => {
  if (!isJsonObject(input)) {
    return {
      parameters: {},
      requestBody: Option.fromNullishOr(input),
      unknown: []
    }
  }

  const parameters: Record<string, Json> = {}
  const bodyProperties: Record<string, Json> = {}
  const unknown: Array<string> = []
  let wholeBody = Option.none<Json>()

  for (const [name, value] of Object.entries(input)) {
    const location = call.locations[name]
    if (location === undefined) {
      unknown.push(name)
      continue
    }
    if (location !== "body") {
      parameters[name] = value
      continue
    }
    if (call.bodyProperty === name) {
      wholeBody = Option.some(value)
      continue
    }
    bodyProperties[name] = value
  }

  if (Option.isSome(wholeBody)) {
    return { parameters, requestBody: wholeBody, unknown }
  }
  return {
    parameters,
    requestBody: Object.keys(bodyProperties).length === 0
      ? Option.none()
      : Option.some(bodyProperties),
    unknown
  }
}

/** Required parameters the caller did not supply.
 *
 *  Checked before a request is built: a missing path parameter would otherwise
 *  leave its `{placeholder}` in the URL, and a missing required filter would be
 *  silently dropped — both producing an upstream rejection that names something
 *  other than the real problem. */
export const missingArguments = (
  call: HttpCall,
  parameters: Readonly<Record<string, Json>>
): ReadonlyArray<string> =>
  call.parameters
    .filter((parameter) => parameter.required && parameters[parameter.name] === undefined)
    .map((parameter) => parameter.name)
