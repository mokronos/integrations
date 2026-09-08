import { Option, Predicate, Schema } from "effect"

export type Json = typeof Schema.Json.Type
export type JsonObject = { readonly [key: string]: Json }

const decodeJson = Schema.decodeUnknownOption(Schema.Json)

export const isJsonObject = (value: Json): value is JsonObject =>
  Predicate.isReadonlyObject(value) && !Array.isArray(value)

export const isJsonString = (value: Json): value is string => Predicate.isString(value)

export const isJsonBoolean = (value: Json): value is boolean => Predicate.isBoolean(value)

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const asJson = (value: unknown): Json =>
  Option.getOrElse(decodeJson(value), (): Json => null)

export const property = (value: Json, key: string): Json =>
  isJsonObject(value) ? value[key] ?? null : null

export const stringEntries = (value: Json): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter(isJsonString) : []

export const objectEntries = (value: Json): Record<string, Json> =>
  isJsonObject(value) ? { ...value } : {}

export const parseJsonString = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Json)
)

export type JsonEncodable =
  | Json
  | undefined
  | Date
  | ReadonlyArray<JsonEncodable>
  | { readonly [key: string]: JsonEncodable }
