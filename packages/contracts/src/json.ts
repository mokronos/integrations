import { Option, Predicate, Schema } from "effect"

/** Working with JSON values.
 *
 *  A JSON Schema document, an OpenAPI operation and a tool result are all
 *  `Json`: recursive unions whose branches are only distinguishable
 *  structurally. Every such test lives here, so the rest of the host branches on
 *  a named predicate instead of re-deriving "is this an object" at each site.
 *
 *  These are the boundary. Above them nothing inspects a representation; below
 *  them there is nothing left to parse, because `Json` is already the parsed
 *  form of arbitrary data. */

export type Json = typeof Schema.Json.Type
export type JsonObject = { readonly [key: string]: Json }

const decodeJson = Schema.decodeUnknownOption(Schema.Json)

/** Whether a JSON value is an object rather than an array, a scalar or null. */
export const isJsonObject = (value: Json): value is JsonObject =>
  Predicate.isReadonlyObject(value) && !Array.isArray(value)

/** Whether a JSON value is a string. */
export const isJsonString = (value: Json): value is string => Predicate.isString(value)

/** Whether a JSON value is a boolean. */
export const isJsonBoolean = (value: Json): value is boolean => Predicate.isBoolean(value)

/** Decodes a value produced outside this system — an `oas` projection, a driver
 *  row, an MCP payload — as JSON, defaulting to `null` when it is not
 *  representable: a cyclic object graph, a function, a `Date`.
 *
 *  This is the parse step, so `unknown` here is the input being parsed rather
 *  than input left unparsed. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const asJson = (value: unknown): Json =>
  Option.getOrElse(decodeJson(value), (): Json => null)

/** A property of a JSON object, or `null` when the value is not an object or the
 *  property is absent. Collapsing "missing" and "not an object" is deliberate:
 *  every caller here treats them the same. */
export const property = (value: Json, key: string): Json =>
  isJsonObject(value) ? value[key] ?? null : null

/** The string entries of a JSON array, ignoring anything else in it. */
export const stringEntries = (value: Json): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter(isJsonString) : []

/** A JSON object's own properties as a mutable record, or an empty one. */
export const objectEntries = (value: Json): Record<string, Json> =>
  isJsonObject(value) ? { ...value } : {}

/** Parses a JSON string, or `None` when it is not JSON. */
export const parseJsonString = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Json)
)
