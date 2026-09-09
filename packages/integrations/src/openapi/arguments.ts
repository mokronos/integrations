import { Option } from "effect"
import { isJsonObject, type Json } from "@integrations/contracts"
import type { HttpCall } from "../tool.ts"

export interface SplitArguments {
  readonly parameters: Record<string, Json>
  readonly requestBody: Option.Option<Json>
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

export const missingArguments = (
  call: HttpCall,
  parameters: Readonly<Record<string, Json>>
): ReadonlyArray<string> =>
  call.parameters
    .filter((parameter) => parameter.required && parameters[parameter.name] === undefined)
    .map((parameter) => parameter.name)
