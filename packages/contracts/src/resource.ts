import { Option, Schema } from "effect"
import { BlobId } from "./blob.ts"
import { ToolMeta } from "./tool.ts"
import { Alias } from "./vocabulary.ts"

/** A resource an integration's server lists, in MCP's shape; `meta` is its `_meta`. */
export const ResourceEntry = Schema.Struct({
  uri: Schema.String,
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  meta: Schema.optional(ToolMeta)
})
export type ResourceEntry = typeof ResourceEntry.Type

export const TextResourceContents = Schema.Struct({
  uri: Schema.String,
  mimeType: Schema.optional(Schema.String),
  text: Schema.String,
  meta: Schema.optional(ToolMeta)
})
export type TextResourceContents = typeof TextResourceContents.Type

/** Bytes, base64 as MCP carries them. */
export const BlobResourceContents = Schema.Struct({
  uri: Schema.String,
  mimeType: Schema.optional(Schema.String),
  blob: Schema.String,
  meta: Schema.optional(ToolMeta)
})
export type BlobResourceContents = typeof BlobResourceContents.Type

export const ResourceContents = Schema.Union([TextResourceContents, BlobResourceContents])
export type ResourceContents = typeof ResourceContents.Type

/**
 * One namespace for everything the gateway serves as a resource: its own blobs,
 * and each connection's upstream resources under that connection's alias, so
 * two servers' URIs never collide and every read finds its way back.
 * MCP App views keep the `ui:` scheme hosts look for, with the alias as host.
 */

export const blobResourcePrefix = "integrations://blobs/"
export const connectionResourcePrefix = "integrations://connections/"
export const uiResourceScheme = "ui://"

export const blobResourceUri = (id: BlobId): string => `${blobResourcePrefix}${encodeURIComponent(id)}`

export const connectionResourceUri = (alias: Alias, uri: string): string =>
  uri.startsWith(uiResourceScheme)
    ? `${uiResourceScheme}${alias}/${uri.slice(uiResourceScheme.length)}`
    : `${connectionResourcePrefix}${alias}/${encodeURIComponent(uri)}`

export type ResourceAddress =
  | { readonly kind: "blob"; readonly id: BlobId }
  | { readonly kind: "upstream"; readonly alias: Alias; readonly uri: string }

const decodeAlias = Schema.decodeUnknownOption(Alias)
const decoded = Option.liftThrowable(decodeURIComponent)

/** `<alias>/<rest>`, with the alias checked. */
const aliased = (rest: string): Option.Option<readonly [Alias, string]> => {
  const slash = rest.indexOf("/")
  return slash <= 0
    ? Option.none()
    : Option.map(decodeAlias(rest.slice(0, slash)), (alias) => [alias, rest.slice(slash + 1)] as const)
}

/** The resource a gateway URI names; none for a URI the gateway never handed out. */
export const parseResourceUri = (uri: string): Option.Option<ResourceAddress> => {
  if (uri.startsWith(blobResourcePrefix)) {
    return decoded(uri.slice(blobResourcePrefix.length)).pipe(
      Option.filter((id) => id.length > 0),
      Option.map((id): ResourceAddress => ({ kind: "blob", id: BlobId.make(id) }))
    )
  }
  if (uri.startsWith(uiResourceScheme)) {
    return Option.map(aliased(uri.slice(uiResourceScheme.length)), ([alias, rest]): ResourceAddress => ({
      kind: "upstream",
      alias,
      uri: `${uiResourceScheme}${rest}`
    }))
  }
  if (uri.startsWith(connectionResourcePrefix)) {
    return Option.flatMap(aliased(uri.slice(connectionResourcePrefix.length)), ([alias, rest]) =>
      Option.map(decoded(rest), (upstream): ResourceAddress => ({ kind: "upstream", alias, uri: upstream }))
    )
  }
  return Option.none()
}

/** One file of a skill: its URI, and the digest and size that let a host verify it. */
export const SkillFile = Schema.Struct({ uri: Schema.String, digest: Schema.String, size: Schema.Number })
export type SkillFile = typeof SkillFile.Type

/** A skill an MCP server publishes (MCP Skills extension): where its `SKILL.md` is, and what it holds. */
export const SkillEntry = Schema.Struct({
  uri: Schema.String,
  /** The `SKILL.md` frontmatter as written: `name` and `description`, and whatever else its author put there. */
  frontmatter: Schema.StructWithRest(Schema.Struct({ name: Schema.String, description: Schema.String }), [
    Schema.Record(Schema.String, Schema.Json)
  ]),
  /** Every file of the skill, or `dynamic` for one whose content cannot be pinned by digest. */
  resources: Schema.Union([Schema.Array(SkillFile), Schema.Literal("dynamic")]),
  meta: Schema.optional(ToolMeta)
})
export type SkillEntry = typeof SkillEntry.Type

/**
 * A connection's skills sit under its alias, so two servers' skills never
 * collide: `skill://<alias>/<path>` for the server's own `skill://<path>`,
 * and `skill://<alias>/~<scheme>/<rest>` for a skill it serves under another
 * scheme. The gateway's own skills sit under an authority no alias can take.
 */
export const skillResourceScheme = "skill://"
export const gatewaySkillAuthority = "integrations-gateway"

export const connectionSkillUri = (alias: Alias, uri: string): string => {
  if (uri.startsWith(skillResourceScheme))
    return `${skillResourceScheme}${alias}/${uri.slice(skillResourceScheme.length)}`
  const separator = uri.indexOf("://")
  return `${skillResourceScheme}${alias}/~${uri.slice(0, separator)}/${uri.slice(separator + 3)}`
}

/** A skill of the connection the alias names, by the URI its own server gave it; none for any other URI. */
export const parseSkillUri = (uri: string): Option.Option<{ readonly alias: Alias; readonly uri: string }> => {
  if (!uri.startsWith(skillResourceScheme)) return Option.none()
  return Option.flatMap(aliased(uri.slice(skillResourceScheme.length)), ([alias, rest]) => {
    if (!rest.startsWith("~")) return Option.some({ alias, uri: `${skillResourceScheme}${rest}` })
    const slash = rest.indexOf("/")
    return slash <= 1
      ? Option.none()
      : Option.some({ alias, uri: `${rest.slice(1, slash)}://${rest.slice(slash + 1)}` })
  })
}
