import type { Client } from "@modelcontextprotocol/client"
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { McpError } from "../errors.ts"
import { Egress, gatewayUserAgent } from "../egress/egress.ts"
import { OAuthProtocol } from "../oauth/protocol.ts"
import { whenPresent } from "@integragents/contracts"
import { isJsonObject, type Json, type JsonObject } from "@integragents/contracts"
import { InputRequests, McpEra, SkillEntry, ToolIcon, ToolMeta } from "@integragents/contracts"
import type { ResourceContents, ResourceEntry } from "@integragents/contracts"
import type { InputAnswer, InputRound, McpProbe } from "@integragents/contracts"
import { probeServer } from "./discovery.ts"
import { asMcpError, withClient } from "./session.ts"
import type { McpCredential, McpServer } from "./session.ts"

export type { McpCredential, McpServer } from "./session.ts"

const McpToolAnnotations = Schema.Struct({
  title: Schema.optional(Schema.String),
  readOnlyHint: Schema.optional(Schema.Boolean),
  destructiveHint: Schema.optional(Schema.Boolean),
  idempotentHint: Schema.optional(Schema.Boolean),
  openWorldHint: Schema.optional(Schema.Boolean)
})
export type McpToolAnnotations = typeof McpToolAnnotations.Type

export const McpToolDefinition = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json),
  annotations: Schema.optional(McpToolAnnotations),
  icons: Schema.optional(Schema.Array(ToolIcon)),
  _meta: Schema.optional(ToolMeta)
})
export type McpToolDefinition = typeof McpToolDefinition.Type

const decodeTools = Schema.decodeUnknownEffect(Schema.Array(McpToolDefinition))

const WireResource = Schema.Struct({
  uri: Schema.String,
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  _meta: Schema.optional(ToolMeta)
})
const WireContents = Schema.Union([
  Schema.Struct({
    uri: Schema.String,
    mimeType: Schema.optional(Schema.String),
    text: Schema.String,
    _meta: Schema.optional(ToolMeta)
  }),
  Schema.Struct({
    uri: Schema.String,
    mimeType: Schema.optional(Schema.String),
    blob: Schema.String,
    _meta: Schema.optional(ToolMeta)
  })
])
const decodeResources = Schema.decodeUnknownEffect(Schema.Array(WireResource))

const WireSkill = Schema.Struct({
  uri: Schema.String,
  frontmatter: SkillEntry.fields.frontmatter,
  resources: SkillEntry.fields.resources,
  _meta: Schema.optional(ToolMeta)
})
const decodeSkills = Schema.decodeUnknownEffect(Schema.Array(WireSkill))

const skillOf = ({ _meta, ...rest }: typeof WireSkill.Type): SkillEntry => ({ ...rest, ...whenPresent("meta", _meta) })
const decodeContents = Schema.decodeUnknownEffect(Schema.Array(WireContents))

/** MCP spells metadata `_meta`; the gateway's own shapes call it `meta`. */
const resourceOf = ({ _meta, ...rest }: typeof WireResource.Type): ResourceEntry => ({
  ...rest,
  ...whenPresent("meta", _meta)
})

const contentsOf = (contents: typeof WireContents.Type): ResourceContents => {
  const shared = {
    uri: contents.uri,
    ...whenPresent("mimeType", contents.mimeType),
    ...whenPresent("meta", contents._meta)
  }
  return "text" in contents ? { ...shared, text: contents.text } : { ...shared, blob: contents.blob }
}

const unreadable = (endpoint: string, detail: string) => (cause: Schema.SchemaError) =>
  new McpError({ endpoint, reason: "protocol", detail, cause })
const decodeJson = Schema.decodeUnknownEffect(Schema.Json)

export interface McpToolListing {
  readonly tools: ReadonlyArray<McpToolDefinition>
  readonly era: McpEra
  /** How long the server said its list stays fresh; 2025-era servers say nothing. */
  readonly ttlMs: Option.Option<number>
}

const ListingFreshness = Schema.Struct({ ttlMs: Schema.optional(Schema.Number) })
const decodeFreshness = Schema.decodeUnknownOption(ListingFreshness)

const callArguments = (input: Json): JsonObject | undefined => (isJsonObject(input) ? input : undefined)

/** A tool call's outcome: its result, or a round of input it needs first (MCP 2026-07-28 `input_required`). */
export type McpCallResult =
  | { readonly kind: "complete"; readonly result: Json; readonly declined: ReadonlyArray<string> }
  | { readonly kind: "input-required"; readonly round: InputRound }

const InputRequiredResult = Schema.Struct({
  resultType: Schema.Literal("input_required"),
  inputRequests: Schema.optional(InputRequests),
  requestState: Schema.optional(Schema.String)
})
const decodeInputRequiredResult = Schema.decodeUnknownOption(InputRequiredResult)

const callResultOf = (result: Json, declined: ReadonlyArray<string>): McpCallResult =>
  Option.match(decodeInputRequiredResult(result), {
    onNone: (): McpCallResult => ({ kind: "complete", result, declined: [...declined] }),
    onSome: (asked): McpCallResult => ({
      kind: "input-required",
      round: { inputRequests: asked.inputRequests ?? {}, ...whenPresent("requestState", asked.requestState) }
    })
  })

/** A refusal handed back the way a tool reports its own error, so the caller can fix its arguments. */
const refusalResult = (message: string): Json => ({
  content: [{ type: "text", text: message }],
  isError: true
})

const decodeEra = (endpoint: string, client: Client) =>
  Schema.decodeUnknownEffect(McpEra)(client.getProtocolEra()).pipe(
    Effect.mapError(
      (cause) => new McpError({ endpoint, reason: "protocol", detail: "the session negotiated no protocol era", cause })
    )
  )

export class McpClient extends Context.Service<
  McpClient,
  {
    readonly probe: (endpoint: string) => Effect.Effect<McpProbe, McpError>
    readonly listTools: (
      server: McpServer,
      credential: Option.Option<McpCredential>
    ) => Effect.Effect<McpToolListing, McpError>
    /** Everything the server lists as a resource, across every page; nothing from a server that serves none. */
    readonly listResources: (
      server: McpServer,
      credential: Option.Option<McpCredential>
    ) => Effect.Effect<ReadonlyArray<ResourceEntry>, McpError>
    readonly readResource: (
      server: McpServer,
      credential: Option.Option<McpCredential>,
      uri: string
    ) => Effect.Effect<ReadonlyArray<ResourceContents>, McpError>
    /** The skills the server publishes (MCP Skills extension); none from a server without the extension. */
    readonly listSkills: (
      server: McpServer,
      credential: Option.Option<McpCredential>
    ) => Effect.Effect<ReadonlyArray<SkillEntry>, McpError>
    /** One skill by the URI of its `SKILL.md`; none when the server does not serve it. */
    readonly getSkill: (
      server: McpServer,
      credential: Option.Option<McpCredential>,
      uri: string
    ) => Effect.Effect<Option.Option<SkillEntry>, McpError>
    /** One round of a call; `answer` continues the round a previous call ended with. */
    readonly callTool: (
      server: McpServer,
      credential: Option.Option<McpCredential>,
      tool: string,
      input: Json,
      answer?: InputAnswer
    ) => Effect.Effect<McpCallResult, McpError>
  }
>()("@integragents/integrations/McpClient") {
  static readonly layer: Layer.Layer<McpClient, never, Egress | HttpClient.HttpClient> = Layer.effect(
    McpClient,
    Effect.gen(function* () {
      const egress = yield* Egress
      const protocol = yield* OAuthProtocol
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeader("user-agent", gatewayUserAgent))
      )

      const listTools = Effect.fn("McpClient.listTools")(
        (server: McpServer, credential: Option.Option<McpCredential>) =>
          withClient(egress.fetch, server, credential, (session) =>
            Effect.gen(function* () {
              const era = yield* decodeEra(server.endpoint, session.client)
              const listed = yield* session
                .run((open, signal) => open.listTools(undefined, { signal }))
                .pipe(Effect.catchTag("SessionFailure", asMcpError(server.endpoint, Option.some("tools/list"))))
              const ttlMs = Option.flatMap(decodeFreshness(listed), (freshness) =>
                Option.fromNullishOr(freshness.ttlMs)
              )
              const tools = yield* decodeTools(listed.tools).pipe(
                Effect.mapError(
                  (cause) =>
                    new McpError({
                      endpoint: server.endpoint,
                      reason: "protocol",
                      detail: "tools/list returned an unreadable tool",
                      cause
                    })
                )
              )
              return { tools, era, ttlMs }
            })
          )
      )

      const probe = Effect.fn("McpClient.probe")(probeServer(client, protocol, egress.fetch))

      const listResources = Effect.fn("McpClient.listResources")(
        (server: McpServer, credential: Option.Option<McpCredential>) =>
          withClient(egress.fetch, server, credential, (session) =>
            session
              .run(async (open, signal) =>
                open.getServerCapabilities()?.resources === undefined
                  ? []
                  : (await open.listResources(undefined, { signal })).resources
              )
              .pipe(
                Effect.catchTag("SessionFailure", asMcpError(server.endpoint, Option.some("resources/list"))),
                Effect.flatMap((listed) =>
                  decodeResources(listed).pipe(
                    Effect.mapError(unreadable(server.endpoint, "resources/list returned an unreadable resource"))
                  )
                ),
                Effect.map((resources) => resources.map(resourceOf))
              )
          )
      )

      const readResource = Effect.fn("McpClient.readResource")(
        (server: McpServer, credential: Option.Option<McpCredential>, uri: string) =>
          withClient(egress.fetch, server, credential, (session) =>
            session
              .run(async (open, signal) => (await open.readResource({ uri }, { signal, cacheMode: "bypass" })).contents)
              .pipe(
                Effect.catchTag("SessionFailure", asMcpError(server.endpoint, Option.some(`resources/read ${uri}`))),
                Effect.flatMap((contents) =>
                  decodeContents(contents).pipe(
                    Effect.mapError(unreadable(server.endpoint, `resources/read ${uri} returned unreadable contents`))
                  )
                ),
                Effect.map((contents) => contents.map(contentsOf))
              )
          )
      )

      const callTool = Effect.fn("McpClient.callTool")(
        (
          server: McpServer,
          credential: Option.Option<McpCredential>,
          tool: string,
          input: Json,
          answer?: InputAnswer
        ) =>
          withClient(egress.fetch, server, credential, (session) =>
            session
              .run((open, signal) =>
                open.callTool(
                  {
                    name: tool,
                    ...whenPresent("arguments", callArguments(input)),
                    ...whenPresent("inputResponses", answer?.inputResponses),
                    ...whenPresent("requestState", answer?.requestState)
                  },
                  { allowInputRequired: true, signal }
                )
              )
              .pipe(
                Effect.catchTag("SessionFailure", (failed) =>
                  Option.match(failed.refusal, {
                    onSome: (message) => Effect.succeed(refusalResult(message)),
                    onNone: () => asMcpError(server.endpoint, Option.some(`tools/call ${tool}`))(failed)
                  })
                ),
                Effect.flatMap((result) =>
                  decodeJson(result).pipe(
                    Effect.mapError(
                      (cause) =>
                        new McpError({
                          endpoint: server.endpoint,
                          reason: "protocol",
                          detail: `tools/call ${tool} returned a non-JSON result`,
                          cause
                        })
                    )
                  )
                ),
                Effect.map((result) => callResultOf(result, session.declined))
              )
          )
      )

      const listSkills = Effect.fn("McpClient.listSkills")(
        (server: McpServer, credential: Option.Option<McpCredential>) =>
          withClient(egress.fetch, server, credential, (session) =>
            session
              .run(async (open, signal) => {
                const skills = new SkillsClient(open, { skipInvalid: true })
                return skills.supported ? (await skills.list(undefined, { signal })).skills : []
              })
              .pipe(
                Effect.catchTag("SessionFailure", asMcpError(server.endpoint, Option.some("skills/list"))),
                Effect.flatMap((listed) =>
                  decodeSkills(listed).pipe(
                    Effect.mapError(unreadable(server.endpoint, "skills/list returned an unreadable skill"))
                  )
                ),
                Effect.map((skills) => skills.map(skillOf))
              )
          )
      )

      const getSkill = Effect.fn("McpClient.getSkill")(
        (server: McpServer, credential: Option.Option<McpCredential>, uri: string) =>
          withClient(egress.fetch, server, credential, (session) =>
            session
              .run(async (open, signal) => {
                const skills = new SkillsClient(open)
                return skills.supported ? [(await skills.get(uri, { signal })).skill] : []
              })
              .pipe(
                Effect.catchTag("SessionFailure", (failed) =>
                  Option.isSome(failed.refusal)
                    ? Effect.succeed([])
                    : asMcpError(server.endpoint, Option.some(`skills/get ${uri}`))(failed)
                ),
                Effect.flatMap((found) =>
                  decodeSkills(found).pipe(
                    Effect.mapError(unreadable(server.endpoint, `skills/get ${uri} returned an unreadable skill`))
                  )
                ),
                Effect.map((skills) => Option.map(Option.fromNullishOr(skills[0]), skillOf))
              )
          )
      )

      return { probe, listTools, listResources, readResource, listSkills, getSkill, callTool }
    })
  ).pipe(Layer.provide(OAuthProtocol.layer))
}
