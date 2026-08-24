import { Schema } from "effect"

/** What an integration is, and what it will accept as proof of authorization. */

/** Where a credential goes on the wire. `env` describes handing a value to a
 *  child process, which the gateway does not run — it is carried so a
 *  description round-trips, not because the gateway can satisfy it. */
export const AuthPlacement = Schema.Struct({
  carrier: Schema.Literals(["header", "query", "env"]),
  name: Schema.String,
  prefix: Schema.String,
  variable: Schema.optional(Schema.String),
  literal: Schema.optional(Schema.String)
})
export type AuthPlacement = typeof AuthPlacement.Type

/** One way to authenticate to an integration. Derived from evidence — how an
 *  MCP endpoint refuses an anonymous call, or what an OpenAPI document declares
 *  — never hand-authored. */
export const AuthMethod = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["oauth", "apikey", "header", "none"]),
  /** Which auth shape a connection is created against. */
  template: Schema.String,
  placements: Schema.optional(Schema.Array(AuthPlacement)),
  oauth: Schema.optional(Schema.Struct({
    discoveryUrl: Schema.optional(Schema.String),
    authorizationUrl: Schema.optional(Schema.String),
    tokenUrl: Schema.optional(Schema.String),
    resource: Schema.optional(Schema.NullOr(Schema.String)),
    scopes: Schema.optional(Schema.Array(Schema.String)),
    registrationEndpoint: Schema.optional(Schema.String),
    supportsDynamicRegistration: Schema.optional(Schema.Boolean),
    supportsClientIdMetadataDocument: Schema.optional(Schema.Boolean)
  }))
})
export type AuthMethod = typeof AuthMethod.Type

/** An external system in a tenant's catalog. */
export const Integration = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.String,
  kind: Schema.String,
  canRemove: Schema.Boolean,
  canRefresh: Schema.Boolean,
  authMethods: Schema.Array(AuthMethod),
  displayUrl: Schema.optional(Schema.String),
  family: Schema.optional(Schema.String)
})
export type Integration = typeof Integration.Type

/** What kind of thing an endpoint turned out to be, and how sure we are. */
export const EndpointDetection = Schema.Struct({
  kind: Schema.String,
  confidence: Schema.Literals(["high", "medium", "low"]),
  endpoint: Schema.String,
  name: Schema.String,
  slug: Schema.String
})
export type EndpointDetection = typeof EndpointDetection.Type

/** What an unauthenticated request to an MCP endpoint revealed. */
export const McpProbe = Schema.Struct({
  connected: Schema.Boolean,
  requiresAuthentication: Schema.Boolean,
  requiresOAuth: Schema.Boolean,
  supportsDynamicRegistration: Schema.Boolean,
  name: Schema.String,
  slug: Schema.String,
  toolCount: Schema.NullOr(Schema.Number),
  serverName: Schema.NullOr(Schema.String),
  instructions: Schema.NullOr(Schema.String)
})
export type McpProbe = typeof McpProbe.Type

/** A read-only summary of an OpenAPI document, shown before anything is
 *  installed. */
export const OpenApiPreview = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  operationCount: Schema.Number,
  operations: Schema.Array(Schema.Struct({
    operationId: Schema.String,
    method: Schema.Literals(["get", "put", "post", "delete", "patch", "head", "options", "trace"]),
    path: Schema.String,
    summary: Schema.NullOr(Schema.String),
    tags: Schema.Array(Schema.String),
    deprecated: Schema.Boolean
  })),
  tags: Schema.Array(Schema.String),
  servers: Schema.Array(Schema.Struct({
    url: Schema.String,
    description: Schema.NullOr(Schema.String)
  })),
  securitySchemes: Schema.Array(Schema.Struct({
    name: Schema.String,
    type: Schema.Literals(["http", "apiKey", "oauth2", "openIdConnect"]),
    scheme: Schema.NullOr(Schema.String),
    bearerFormat: Schema.NullOr(Schema.String),
    in: Schema.NullOr(Schema.Literals(["header", "query", "cookie"])),
    headerName: Schema.NullOr(Schema.String),
    description: Schema.NullOr(Schema.String),
    openIdConnectUrl: Schema.NullOr(Schema.String)
  }))
})
export type OpenApiPreview = typeof OpenApiPreview.Type
