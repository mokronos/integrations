import { Validator } from "@cfworker/json-schema"
import type { Schema as JsonSchemaDocument, SchemaDraft } from "@cfworker/json-schema"
import { isJsonObject, isJsonString, property } from "@integrations/contracts"
import type { InvocationInvalid, Json, JsonObject } from "@integrations/contracts"

const draftOf = (schema: JsonObject): SchemaDraft => {
  const declared = property(schema, "$schema")
  if (!isJsonString(declared)) return "2020-12"
  if (declared.includes("2020-12")) return "2020-12"
  if (declared.includes("2019-09")) return "2019-09"
  if (declared.includes("draft-04")) return "4"
  return "7"
}

const asDocument = (schema: JsonObject): JsonSchemaDocument => ({ ...schema })

const describeLocation = (instanceLocation: string): string => {
  const path = instanceLocation.replace(/^#\/?/, "").split("/").filter((part) => part.length > 0)
  return path.length === 0 ? "arguments" : path.join(".")
}

/**
 * Check a call's arguments against the tool's declared input schema. A tool
 * without a usable object schema is not checked; the vendor decides then.
 */
export const invalidArguments = (
  inputSchema: Json | undefined,
  value: Json,
  tool: string
): InvocationInvalid | undefined => {
  if (inputSchema === undefined || !isJsonObject(inputSchema)) return undefined
  const result = new Validator(asDocument(inputSchema), draftOf(inputSchema), false).validate(value)
  if (result.valid) return undefined
  const locations = result.errors.map((unit) => unit.instanceLocation)
  const seen = new Set<string>()
  const issues = result.errors
    .filter((unit) => !locations.some((other) => other !== unit.instanceLocation && other.startsWith(`${unit.instanceLocation}/`)))
    .map((unit) => ({ path: describeLocation(unit.instanceLocation), message: unit.error }))
    .filter((issue) => {
      const key = `${issue.path}: ${issue.message}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  const headline = issues[0]
  return {
    status: "invalid",
    message: headline === undefined
      ? `The arguments do not match what ${tool} accepts`
      : `${tool} rejected its arguments: ${headline.path} ${headline.message}`,
    issues
  }
}
