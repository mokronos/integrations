import { Validator } from "@cfworker/json-schema"
import type { OutputUnit, Schema as JsonSchemaDocument, SchemaDraft } from "@cfworker/json-schema"
import { isJsonObject, isJsonString, property } from "@integragents/contracts"
import type { Issue, Json, JsonObject } from "@integragents/contracts"

const draftOf = (schema: JsonObject): SchemaDraft => {
  const declared = property(schema, "$schema")
  if (!isJsonString(declared)) return "2020-12"
  if (declared.includes("2020-12")) return "2020-12"
  if (declared.includes("2019-09")) return "2019-09"
  if (declared.includes("draft-04")) return "4"
  return "7"
}

const asDocument = (schema: JsonObject): JsonSchemaDocument => ({ ...schema })

const segmentsOf = (instanceLocation: string): ReadonlyArray<string> =>
  instanceLocation
    .replace(/^#\/?/, "")
    .split("/")
    .filter((part) => part.length > 0)

const missingProperty = /required property "(.+)"/

/** Where the problem is: a missing property is named by its own path, not the object that lacks it. */
const issueOf = (unit: OutputUnit): Issue => {
  const segments = segmentsOf(unit.instanceLocation)
  const missing = unit.keyword === "required" ? missingProperty.exec(unit.error)?.[1] : undefined
  if (missing !== undefined) return { path: [...segments, missing].join("."), message: "is required" }
  return { path: segments.length === 0 ? "(root)" : segments.join("."), message: unit.error }
}

/**
 * Where `value` fails `schema`, deepest places only and each once; nothing
 * when it fits, or when `schema` is not an object schema to check against.
 */
export const jsonSchemaIssues = (schema: Json | undefined, value: Json): ReadonlyArray<Issue> | undefined => {
  if (schema === undefined || !isJsonObject(schema)) return undefined
  const result = new Validator(asDocument(schema), draftOf(schema), false).validate(value)
  if (result.valid) return undefined
  const locations = result.errors.map((unit) => unit.instanceLocation)
  const seen = new Set<string>()
  return result.errors
    .filter(
      (unit) =>
        !locations.some((other) => other !== unit.instanceLocation && other.startsWith(`${unit.instanceLocation}/`))
    )
    .map(issueOf)
    .filter((issue) => {
      const key = `${issue.path}: ${issue.message}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
