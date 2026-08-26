import { Schema } from "effect"

export const IntegrationSearchKind = Schema.Literals(["mcp", "openapi", "graphql", "cli"])
export type IntegrationSearchKind = typeof IntegrationSearchKind.Type

export const IntegrationSearchQuery = Schema.Struct({
  q: Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed()),
  kind: Schema.optional(IntegrationSearchKind),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
  )
})
export type IntegrationSearchQuery = typeof IntegrationSearchQuery.Type

/** `url` is the one address `discover` accepts for this surface — the MCP
 * endpoint, or the OpenAPI document, never the human landing page. Absent when
 * the surface cannot be discovered (GraphQL) or is not addressed by URL (CLI). */
export const IntegrationSearchSurface = Schema.Struct({
  type: Schema.Literals(["http", "openapi", "graphql", "mcp", "cli"]),
  slug: Schema.String,
  name: Schema.String,
  url: Schema.optional(Schema.String),
  transports: Schema.optional(Schema.Array(Schema.String)),
  command: Schema.optional(Schema.String)
})
export type IntegrationSearchSurface = typeof IntegrationSearchSurface.Type

export const IntegrationSearchMatch = Schema.Struct({
  domain: Schema.String,
  name: Schema.String,
  description: Schema.String,
  surfaces: Schema.Array(IntegrationSearchSurface)
})
export type IntegrationSearchMatch = typeof IntegrationSearchMatch.Type

export const IntegrationSearchResponse = Schema.Struct({
  query: Schema.String,
  results: Schema.Array(IntegrationSearchMatch)
})
export type IntegrationSearchResponse = typeof IntegrationSearchResponse.Type
