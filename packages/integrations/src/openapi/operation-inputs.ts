import { Option, Schema } from "effect"
import { whenPresent, type Json } from "@integragents/contracts"
import type { ParameterLocation } from "@integragents/contracts"
import type { CallParameter } from "../tool.ts"

export const WireLocation = Schema.Literals(["path", "query", "header", "cookie"])

export interface WireParameter {
  readonly name: string
  readonly location: typeof WireLocation.Type
  readonly style: string
  readonly explode: boolean
  readonly required: boolean
}

export type OperationInput =
  | {
    readonly kind: "parameter"
    readonly argument: string
    readonly parameter: WireParameter
    readonly schema: Json
  }
  | {
    readonly kind: "body"
    readonly argument: string
    readonly schema: Json
    readonly required: boolean
  }

export interface AssembledInputs {
  readonly properties: Record<string, Json>
  readonly required: ReadonlyArray<string>
  readonly locations: Record<string, ParameterLocation>
  readonly parameters: ReadonlyArray<CallParameter>
  readonly bodyProperty: Option.Option<string>
}

const locationRank = {
  path: 0,
  query: 1,
  header: 2,
  cookie: 3,
  body: 4
} satisfies Record<ParameterLocation, number>

const locationOf = (input: OperationInput): ParameterLocation =>
  input.kind === "body" ? "body" : input.parameter.location

const fallbackArgument = (input: OperationInput): string =>
  input.kind === "body" ? "requestBody" : `${input.argument}_${input.parameter.location}`

const withUniqueArguments = (
  inputs: ReadonlyArray<OperationInput>
): ReadonlyArray<OperationInput> => {
  const taken = new Set<string>()
  const claim = (input: OperationInput): string => {
    const fallback = fallbackArgument(input)
    let chosen = taken.has(input.argument) ? fallback : input.argument
    for (let suffix = 2; taken.has(chosen); suffix++) chosen = `${fallback}_${suffix}`
    taken.add(chosen)
    return chosen
  }
  return inputs
    .toSorted((left, right) => locationRank[locationOf(left)] - locationRank[locationOf(right)])
    .map((input) => ({ ...input, argument: claim(input) }))
}

export const assembleInputs = (inputs: ReadonlyArray<OperationInput>): AssembledInputs => {
  const unique = withUniqueArguments(inputs)
  const properties: Record<string, Json> = {}
  const locations: Record<string, ParameterLocation> = {}
  const required: Array<string> = []
  const parameters: Array<CallParameter> = []
  let bodyProperty = Option.none<string>()

  for (const input of unique) {
    properties[input.argument] = input.schema
    locations[input.argument] = locationOf(input)
    if (input.kind === "body") {
      if (input.required) required.push(input.argument)
      bodyProperty = Option.some(input.argument)
      continue
    }
    if (input.parameter.required) required.push(input.argument)
    parameters.push({ argument: input.argument, ...input.parameter })
  }

  return { properties, required, locations, parameters, bodyProperty }
}

export const inputSchemaOf = (assembled: AssembledInputs): Json => ({
  type: "object",
  properties: assembled.properties,
  ...whenPresent("required", assembled.required.length === 0 ? undefined : assembled.required),
  additionalProperties: false
})
