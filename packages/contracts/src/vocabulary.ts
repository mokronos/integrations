import { Schema } from "effect"

/**
 * Separators are single and internal. Alias segments are joined by a run of
 * three underscores, so parts must never be able to grow a run that long.
 */
const slugPattern = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/

export const IntegrationSlug = Schema.String.check(Schema.isPattern(slugPattern)).pipe(
  Schema.brand("IntegrationSlug")
)
export type IntegrationSlug = typeof IntegrationSlug.Type

export const ConnectionName = Schema.String.check(Schema.isPattern(slugPattern)).pipe(
  Schema.brand("ConnectionName")
)
export type ConnectionName = typeof ConnectionName.Type

export const ToolName = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("ToolName")
)
export type ToolName = typeof ToolName.Type

/** Who a connection belongs to: the organisation, or one person by subject id. */
export const ConnectionOwner = Schema.Union([
  Schema.Literal("org"),
  Schema.TemplateLiteral(["user:", Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))])
])
export type ConnectionOwner = typeof ConnectionOwner.Type

/** Aliases address tools in generated code, so they stay valid JS identifiers. */
export const Alias = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/)).pipe(
  Schema.brand("Alias")
)
export type Alias = typeof Alias.Type

export const ApprovalStatus = Schema.Literals(["pending", "executing", "approved", "denied", "expired"])
export type ApprovalStatus = typeof ApprovalStatus.Type

export const ParameterLocation = Schema.Literals(["path", "query", "header", "cookie", "body"])
export type ParameterLocation = typeof ParameterLocation.Type

export const HttpMethod = Schema.Literals(["get", "put", "post", "delete", "patch", "head", "options", "trace"])
export type HttpMethod = typeof HttpMethod.Type
