import { Schema } from "effect"

const slugPattern = /^[a-z0-9][a-z0-9_-]*$/

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

export const OwnerTier = Schema.Literals(["org", "user"])
export type OwnerTier = typeof OwnerTier.Type

export const Alias = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]*$/)).pipe(
  Schema.brand("Alias")
)
export type Alias = typeof Alias.Type

export const ApprovalStatus = Schema.Literals(["pending", "executing", "approved", "denied", "expired"])
export type ApprovalStatus = typeof ApprovalStatus.Type
