import { Schema } from "effect"

/** The system's shared vocabulary.
 *
 *  Every identifier below has exactly one definition. That matters more than it
 *  looks: `Schema.brand("IntegrationSlug")` keys the brand on the string, so two
 *  independent definitions of the same name produce the *same* TypeScript type
 *  while validating differently. One side could then hand the other a value it
 *  would have rejected, and the compiler would say nothing.
 *
 *  Terms are the ones defined in `CONTEXT.md`. */

/** Slug-like: lowercase, and free of `.` because a tool address is
 *  dot-delimited and every segment but the last must parse positionally. */
const slugPattern = /^[a-z0-9][a-z0-9_-]*$/

/** An integration's stable key in a tenant's catalog. */
export const IntegrationSlug = Schema.String.check(Schema.isPattern(slugPattern)).pipe(
  Schema.brand("IntegrationSlug")
)
export type IntegrationSlug = typeof IntegrationSlug.Type

/** The label distinguishing several connections to one integration under one
 *  owner tier — three Google accounts as `personal`, `work`, `client-x`. */
export const ConnectionName = Schema.String.check(Schema.isPattern(slugPattern)).pipe(
  Schema.brand("ConnectionName")
)
export type ConnectionName = typeof ConnectionName.Type

/** A tool's name as its own source spells it. Unlike every other address
 *  segment this one may contain dots — an OpenAPI `aliases.deleteAlias` is one
 *  name, not two segments. */
export const ToolName = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("ToolName")
)
export type ToolName = typeof ToolName.Type

/** Which of two partitions a connection is filed under: `org` is shared by the
 *  whole tenant, `user` belongs to one subject. A tool address names this
 *  segment, so the two are distinct addresses rather than one shadowing the
 *  other. */
export const OwnerTier = Schema.Literals(["org", "user"])
export type OwnerTier = typeof OwnerTier.Type

/** The logical name a client binding exposes a tool under. Declared as a requirement by
 *  the caller and bound to a connection per deployment. */
export const Alias = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]*$/)).pipe(
  Schema.brand("Alias")
)
export type Alias = typeof Alias.Type
