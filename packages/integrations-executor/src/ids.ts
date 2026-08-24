import { Option, Schema } from "effect"
import { ExecutorOwner, ExecutorToolAddress } from "./schemas.ts"

/** The identifiers the integration host addresses things by.
 *
 *  These replace the branded ids the Executor SDK used to own. The wire-facing
 *  shapes still live in `@mokronos/integrations-protocol`; everything here is
 *  the host's internal spelling of the same names, branded so a slug can never
 *  be passed where a connection name belongs. */

const slugPattern = /^[a-z0-9][a-z0-9_-]*$/

/** An integration's stable key in the catalog. Lowercase so an address parses
 *  case-insensitively, and free of `.` because the address is dot-delimited. */
export const IntegrationSlug = Schema.String.pipe(
  Schema.refine((value): value is string => slugPattern.test(value)),
  Schema.brand("IntegrationSlug")
)
export type IntegrationSlug = typeof IntegrationSlug.Type

/** The label distinguishing several connections to one integration under one
 *  owner tier. Same character class as a slug: it is an address segment too. */
export const ConnectionName = Schema.String.pipe(
  Schema.refine((value): value is string => slugPattern.test(value)),
  Schema.brand("ConnectionName")
)
export type ConnectionName = typeof ConnectionName.Type

/** Which auth shape a connection was created against — `none`, `bearer`, an
 *  OpenAPI security scheme name, or `oauth2`. */
export const AuthTemplateSlug = Schema.String.pipe(
  Schema.refine((value): value is string => value.length > 0),
  Schema.brand("AuthTemplateSlug")
)
export type AuthTemplateSlug = typeof AuthTemplateSlug.Type

export const OAuthClientSlug = Schema.String.pipe(
  Schema.refine((value): value is string => value.length > 0),
  Schema.brand("OAuthClientSlug")
)
export type OAuthClientSlug = typeof OAuthClientSlug.Type

/** The opaque CSRF value that ties an authorization redirect back to the
 *  pending flow row that started it. */
export const OAuthState = Schema.String.pipe(
  Schema.refine((value): value is string => value.length > 0),
  Schema.brand("OAuthState")
)
export type OAuthState = typeof OAuthState.Type

/** A tool's name as its own source spells it. Unlike every other segment this
 *  one may contain dots — an OpenAPI `aliases.deleteAlias` addresses naturally
 *  as the whole remainder of the address. */
export const ToolName = Schema.String.pipe(
  Schema.refine((value): value is string => value.length > 0),
  Schema.brand("ToolName")
)
export type ToolName = typeof ToolName.Type

/** `tools.<integration>.<owner>.<connection>` — a connection's address.
 *
 *  Deliberately the exact prefix of every tool address it carries, so a reader
 *  who has one can see at a glance which connection a tool runs under, and a
 *  listing sorts connections and their tools together. */
export const ConnectionAddress = Schema.String.pipe(
  Schema.refine((value): value is string => value.length > 0),
  Schema.brand("ConnectionAddress")
)
export type ConnectionAddress = typeof ConnectionAddress.Type

export interface ParsedToolAddress {
  readonly integration: IntegrationSlug
  readonly owner: ExecutorOwner
  readonly connection: ConnectionName
  readonly tool: ToolName
}

const decodeAddressParts = Schema.decodeUnknownOption(Schema.Struct({
  integration: IntegrationSlug,
  owner: ExecutorOwner,
  connection: ConnectionName,
  tool: ToolName
}))

/** Parses a callable address, or `None` when it is not a well-formed
 *  `tools.<integration>.<owner>.<connection>.<tool>`.
 *
 *  The four leading segments are slug-like and never contain a `.`; the tool
 *  segment is the entire remainder after the fourth dot, so a dotted tool name
 *  round-trips. */
export const parseToolAddress = (address: string): Option.Option<ParsedToolAddress> => {
  const segments = address.split(".")
  const [prefix, integration, owner, connection] = segments
  if (prefix !== "tools" || segments.length < 5) return Option.none()
  const tool = segments.slice(4).join(".")
  if (integration === undefined || owner === undefined || connection === undefined) {
    return Option.none()
  }
  return decodeAddressParts({ integration, owner, connection, tool })
}

export const toolAddress = (parts: ParsedToolAddress): ExecutorToolAddress =>
  ExecutorToolAddress.make(
    `tools.${parts.integration}.${parts.owner}.${parts.connection}.${parts.tool}`
  )

export const connectionAddress = (parts: {
  readonly owner: ExecutorOwner
  readonly integration: IntegrationSlug
  readonly connection: ConnectionName
}): ConnectionAddress =>
  ConnectionAddress.make(
    `tools.${parts.integration}.${parts.owner}.${parts.connection}`
  )

/** Derives a catalog slug from a human name or hostname. The catalog needs one
 *  for every installed integration and vendors rarely supply a usable one. */
export const slugify = (value: string): Option.Option<IntegrationSlug> =>
  Schema.decodeUnknownOption(IntegrationSlug)(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
  )
