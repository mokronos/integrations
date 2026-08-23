import { Schema } from "effect"

export const IntegrationSearchKind = Schema.Literals(["mcp", "openapi", "graphql", "cli"])
export type IntegrationSearchKind = typeof IntegrationSearchKind.Type

export const IntegrationSearchQuery = Schema.Struct({
  q: Schema.String.pipe(
    Schema.refine((value): value is string => value.trim().length > 0)
  ),
  kind: Schema.optional(IntegrationSearchKind),
  limit: Schema.optional(Schema.Int.pipe(
    Schema.refine((value): value is number => value >= 1 && value <= 100)
  ))
})
export type IntegrationSearchQuery = typeof IntegrationSearchQuery.Type

export const IntegrationSearchSurface = Schema.Struct({
  type: Schema.Literals(["http", "openapi", "graphql", "mcp", "cli"]),
  slug: Schema.String,
  name: Schema.String,
  url: Schema.optional(Schema.String),
  spec: Schema.optional(Schema.String),
  transports: Schema.optional(Schema.Array(Schema.String)),
  command: Schema.optional(Schema.String),
  discoveryUrl: Schema.optional(Schema.String)
})
export type IntegrationSearchSurface = typeof IntegrationSearchSurface.Type

export const IntegrationSearchMatch = Schema.Struct({
  domain: Schema.String,
  name: Schema.String,
  description: Schema.String,
  kinds: Schema.Array(IntegrationSearchKind),
  url: Schema.String,
  surfaces: Schema.Array(IntegrationSearchSurface)
})
export type IntegrationSearchMatch = typeof IntegrationSearchMatch.Type

export const IntegrationSearchResponse = Schema.Struct({
  query: Schema.String,
  results: Schema.Array(IntegrationSearchMatch)
})
export type IntegrationSearchResponse = typeof IntegrationSearchResponse.Type
