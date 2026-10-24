import { expect } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { delegationTemplateOf, ToolAddress, whenPresent, whenTrue } from "@integragents/contracts"
import { makeGatewayEvents, publishingStore } from "@integragents/gateway-core"
import type { ApprovalReviewer, OAuthSessions } from "@integragents/gateway-core"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type {
  Connection,
  ConnectionOwner,
  ResourceContents,
  ResourceEntry,
  SkillEntry,
  Tool
} from "@integragents/contracts"
import { InvocationError, StorageError } from "@integragents/integrations"
import type { BlobStore, IntegrationFailure, ToolExecution } from "@integragents/integrations"
import { stubIntegrationsContext } from "./stubs.ts"
import { openDatabase, storeOn, temporaryDirectory } from "./fixtures.ts"
import {
  ConnectionName,
  createGatewayHandler,
  defaultTenantId,
  generateApiKey,
  IntegrationSlug,
  newProfileId,
  SubjectId,
  ToolName
} from "./gateway.ts"
import type { ConnectionRef, GatewayStore, ProfileToolInput } from "./gateway.ts"

export const JsonBody = Schema.Record(Schema.String, Schema.Json)
export const JsonRows = Schema.Array(JsonBody)
export const isApprovalId = Schema.is(Schema.String)

export const connection: ConnectionRef = {
  owner: "user",
  subject: SubjectId.make("sebastian"),
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}

interface ExecutedCall {
  readonly address: string
  readonly input: typeof Schema.Json.Type
}

const stubConnection = (reference: {
  readonly integration: string
  readonly name: string
  readonly scope?: string
}): Connection => ({
  owner: "user:sebastian",
  name: ConnectionName.make(reference.name),
  integration: IntegrationSlug.make(reference.integration),
  template: reference.integration,
  address: `connections.${reference.integration}.user.${reference.name}`,
  provider: reference.integration,
  status: "connected",
  ...whenPresent("oauthScope", reference.scope)
})

const stubTool = (tool: {
  readonly address: string
  readonly name: string
  readonly owner?: ConnectionOwner
  readonly defaultDecision?: "allow" | "require_approval"
}): Tool => ({
  address: ToolAddress.make(tool.address),
  name: ToolName.make(tool.name),
  description: "",
  integration: IntegrationSlug.make("gmail"),
  owner: tool.owner ?? "user:sebastian",
  connection: ConnectionName.make("work"),
  defaultDecision: tool.defaultDecision ?? "require_approval",
  readOnly: tool.defaultDecision === "allow",
  destructive: tool.defaultDecision !== "allow",
  idempotent: tool.defaultDecision === "allow",
  openWorld: true
})

const stubIntegrations = (
  behaviour: {
    readonly beforeExecute?: () => Promise<void>
    readonly fail?: boolean
    /** The catalog's storage breaks under every connection listing. */
    readonly storageFails?: boolean
    readonly connections?: ReadonlyArray<{
      readonly integration: string
      readonly name: string
      readonly scope?: string
    }>
    /** Integrations known to the catalog that offer OAuth, connected or not. */
    readonly oauthIntegrations?: ReadonlyArray<string>
    readonly tools?: ReadonlyArray<{
      readonly address: string
      readonly name: string
      readonly owner?: ConnectionOwner
      readonly defaultDecision?: "allow" | "require_approval"
    }>
    /** What every call returns, instead of `{ ok: true }`. */
    readonly execution?: ToolExecution
    readonly failWith?: IntegrationFailure
    /** What every connection's server publishes as skills. */
    readonly skills?: ReadonlyArray<SkillEntry>
    /** What every connection's server lists and serves as resources. */
    readonly resources?: {
      readonly listed: ReadonlyArray<ResourceEntry>
      readonly contents: Record<string, ReadonlyArray<ResourceContents>>
    }
    /** What the catalog says about every tool, beyond the stub's defaults. */
    readonly described?: Partial<Tool>
    readonly blobs?: BlobStore["Service"]
  } = {}
) => {
  const calls: Array<ExecutedCall> = []
  const removed: Array<{ readonly integration: string; readonly name: string }> = []
  const forgotten: Array<string> = []
  const renamed: Array<{ readonly slug: string; readonly name: string }> = []
  const oauthCapable = new Set(behaviour.oauthIntegrations ?? [])
  const known = new Set([...(behaviour.connections ?? []).map((connection) => connection.integration), ...oauthCapable])
  const integrationServices = stubIntegrationsContext(
    {
      execute: (address, input) => {
        calls.push({ address: String(address), input })
        return Effect.promise(() => behaviour.beforeExecute?.() ?? Promise.resolve()).pipe(
          Effect.flatMap(() =>
            behaviour.failWith !== undefined
              ? Effect.fail(behaviour.failWith)
              : behaviour.fail === true
                ? Effect.fail(
                    new InvocationError({
                      code: "upstream_status",
                      status: 500,
                      detail: "vendor exploded"
                    })
                  )
                : Effect.succeed(
                    behaviour.execution ?? { kind: "complete" as const, result: { ok: true }, attachments: [] }
                  )
          )
        )
      },
      listResources: () => Effect.succeed(behaviour.resources?.listed ?? []),
      readResource: (_reference, uri) => Effect.succeed(behaviour.resources?.contents[uri] ?? []),
      listSkills: () => Effect.succeed(behaviour.skills ?? []),
      getSkill: (_reference, uri) =>
        Effect.succeed(Option.fromNullishOr((behaviour.skills ?? []).find((skill) => skill.uri === uri))),
      toolSummaries: () => Effect.succeed((behaviour.tools ?? []).map(stubTool)),
      listTools: () => Effect.succeed((behaviour.tools ?? []).map(stubTool)),
      describeTool: (target) =>
        Effect.succeed({
          ...stubTool({
            address: String(target),
            name: String(target).split(".").at(-1) ?? "tool"
          }),
          description: "Send an email",
          inputSchema: {
            type: "object",
            properties: { to: { type: "string" } },
            required: ["to"]
          },
          ...behaviour.described
        }),
      listConnections: () =>
        behaviour.storageFails === true
          ? Effect.fail(new StorageError({ message: "listConnections" }))
          : Effect.succeed((behaviour.connections ?? []).map(stubConnection)),
      removeConnection: (reference) =>
        Effect.sync(() => {
          removed.push({ integration: reference.integration, name: reference.name })
        }),
      findIntegration: (slug) =>
        Effect.sync(() =>
          known.has(slug)
            ? Option.some({
                slug,
                name: renamed.find((entry) => entry.slug === slug)?.name ?? String(slug),
                description: "",
                kind: "mcp" as const,
                canRemove: true,
                canRefresh: true,
                authMethods: oauthCapable.has(slug)
                  ? [
                      {
                        id: "oauth",
                        label: "OAuth",
                        kind: "oauth" as const,
                        template: "oauth2",
                        oauth: {
                          authorizationUrl: "https://accounts.example/authorize",
                          tokenUrl: "https://accounts.example/token"
                        }
                      }
                    ]
                  : []
              })
            : Option.none()
        ),
      renameIntegration: (slug, name) =>
        Effect.sync(() => {
          renamed.push({ slug, name })
        }),
      removeIntegration: (slug) =>
        Effect.sync(() => {
          forgotten.push(slug)
        })
    },
    whenPresent("blobs", behaviour.blobs)
  )
  return { calls, removed, forgotten, renamed, integrationServices }
}

export const setup = Effect.fnUntraced(function* (
  options: {
    readonly decision?: "allow" | "require_approval"
    readonly capabilities?: ReadonlyArray<"provision_connections" | "administer_gateway">
    readonly mcpSurface?: "tools" | "discovery"
    readonly beforeExecute?: () => Promise<void>
    readonly fail?: boolean
    /** The catalog's storage breaks under every connection listing. */
    readonly storageFails?: boolean
    readonly connections?: ReadonlyArray<{
      readonly integration: string
      readonly name: string
      readonly scope?: string
    }>
    readonly tools?: ReadonlyArray<{
      readonly address: string
      readonly name: string
      readonly owner?: ConnectionOwner
      readonly defaultDecision?: "allow" | "require_approval"
    }>
    readonly dashboardUrl?: string
    readonly mcpUrl?: string
    /** Grant the tool on the delegation template instead of sebastian's connection. */
    readonly template?: boolean
    readonly oauthStart?: OAuthSessions["start"]
    readonly oauthIntegrations?: ReadonlyArray<string>
    readonly reviewer?: ApprovalReviewer["Service"]
    readonly execution?: ToolExecution
    readonly failWith?: IntegrationFailure
    readonly skills?: ReadonlyArray<SkillEntry>
    readonly resources?: {
      readonly listed: ReadonlyArray<ResourceEntry>
      readonly contents: Record<string, ReadonlyArray<ResourceContents>>
    }
    readonly described?: Partial<Tool>
    readonly blobs?: BlobStore["Service"]
  } = {}
) {
  const sql = yield* openDatabase(yield* temporaryDirectory("gateway-http-"))
  const events = yield* makeGatewayEvents
  const store = publishingStore(yield* storeOn(sql), events)
  const granted: ConnectionRef = options.template === true ? delegationTemplateOf(connection) : connection

  const profile = yield* store.createProfile({
    id: yield* newProfileId,
    tenantId: defaultTenantId,
    name: "support-agent",
    capabilities: options.capabilities ?? ["provision_connections"],
    tools: [{ connection: granted, tool: ToolName.make("sendEmail"), decision: options.decision ?? "allow" }],
    ...whenPresent("mcpSurface", options.mcpSurface)
  })
  const key = yield* generateApiKey
  yield* store.addApiKey({ id: key.id, profileId: profile.id, name: "Claude Desktop", hash: key.hash })
  const stub = stubIntegrations({
    ...whenPresent("beforeExecute", options.beforeExecute),
    ...whenPresent("fail", options.fail),
    ...whenPresent("storageFails", options.storageFails),
    ...whenPresent("connections", options.connections),
    ...whenPresent("tools", options.tools),
    ...whenPresent("oauthIntegrations", options.oauthIntegrations),
    ...whenPresent("execution", options.execution),
    ...whenPresent("failWith", options.failWith),
    ...whenPresent("resources", options.resources),
    ...whenPresent("skills", options.skills),
    ...whenPresent("described", options.described),
    ...whenPresent("blobs", options.blobs)
  })
  const { handle } = createGatewayHandler({
    events,
    httpClient: FetchHttpClient.layer,
    store,
    integrationServices: stub.integrationServices,
    retentionDays: 30,
    ...whenPresent("reviewer", options.reviewer),
    oauth: {
      start: options.oauthStart ?? (() => Effect.die(new Error("not used"))),
      provideClient: () => Effect.sync((): undefined => undefined),
      get: () => Effect.sync((): undefined => undefined),
      completeByState: () => Effect.sync((): undefined => undefined),
      stop: () => Effect.void
    },
    ...whenPresent("dashboardUrl", options.dashboardUrl === undefined ? undefined : () => options.dashboardUrl),
    ...whenPresent("mcpUrl", options.mcpUrl === undefined ? undefined : () => options.mcpUrl)
  })

  /** A request as a caller would send it, decoded the way a caller reads it. */
  const call = Effect.fnUntraced(function* (
    method: string,
    pathname: string,
    init: {
      readonly body?: typeof Schema.Json.Type
      readonly secret?: string | null
      readonly local?: boolean
    } = {}
  ) {
    const secret = init.local === true ? null : init.secret === undefined ? key.secret : init.secret
    const headers =
      secret === null
        ? { "content-type": "application/json" }
        : { "content-type": "application/json", authorization: `Bearer ${secret}` }
    const response = yield* Effect.promise(() =>
      handle(
        new Request(`http://gateway.test${pathname}`, {
          method,
          headers,
          ...whenPresent("body", JSON.stringify(init.body))
        }),
        init.local === true ? { localSecret: key.secret } : undefined
      )
    )
    return {
      status: response.status,
      body: Schema.decodeUnknownSync(JsonBody)(yield* Effect.promise(() => response.json()))
    }
  })

  return {
    store,
    sql,
    profile,
    key,
    handle,
    call,
    calls: stub.calls,
    removed: stub.removed,
    forgotten: stub.forgotten,
    renamed: stub.renamed
  }
})

type Call = Effect.Success<ReturnType<typeof setup>>["call"]

/** A key bound to one person, issued the way an administrator issues it. */
export const keyFor = Effect.fnUntraced(function* (call: Call, profileId: string, subject: string) {
  yield* call("POST", "/v1/subjects", { local: true, body: { id: subject } })
  const issued = yield* call("POST", `/v1/profiles/${profileId}/keys`, {
    local: true,
    body: { name: `${subject}'s assistant`, subject }
  })
  expect(issued.status).toBe(201)
  return String(issued.body["secret"])
})

/** Another profile in the same tenant, holding one key named after it. */
export const profileWithKey = Effect.fnUntraced(function* (
  store: GatewayStore,
  name: string,
  tools: ReadonlyArray<ProfileToolInput>
) {
  const profile = yield* store.createProfile({
    id: yield* newProfileId,
    tenantId: defaultTenantId,
    name,
    capabilities: ["provision_connections"],
    tools
  })
  const key = yield* generateApiKey
  yield* store.addApiKey({ id: key.id, profileId: profile.id, name, hash: key.hash })
  return { profile, key }
})

export const sendEmailOn = (on: ConnectionRef, decision: "allow" | "require_approval"): ProfileToolInput => ({
  connection: on,
  tool: ToolName.make("sendEmail"),
  decision
})

const McpToolResult = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.String)
    })
  )
})
const decodeMcpResult = Schema.decodeUnknownSync(McpToolResult)

export const mcpText = <A>(result: A): string =>
  decodeMcpResult(result)
    .content.map((block) => block.text ?? "")
    .join("")

export const mcpClient = Effect.fnUntraced(function* (
  handle: (request: Request) => Promise<Response>,
  secret: string,
  /** Speaks 2026-07-28 and answers every elicitation with this action; without it the client is a 2025-era one. */
  elicitation?: {
    readonly action: "accept" | "decline" | "cancel"
    readonly asked: Array<string>
    readonly content?: Record<string, string | number | boolean>
    /** The elicitation modes the client declares; form alone when absent. */
    readonly modes?: { readonly form: boolean; readonly url: boolean }
    /** The links URL elicitations asked the human to open. */
    readonly opened?: Array<string>
  }
) {
  const transport = new StreamableHTTPClientTransport(new URL("http://gateway.test/mcp"), {
    authProvider: { token: async () => secret },
    fetch: (input, init) => handle(new Request(input, init))
  })
  return yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const client = new Client(
        { name: "gateway-test", version: "1.0.0" },
        elicitation === undefined
          ? {}
          : {
              capabilities: {
                elicitation: {
                  ...whenTrue(elicitation.modes?.form ?? true, () => ({ form: {} })),
                  ...whenTrue(elicitation.modes?.url ?? false, () => ({ url: {} }))
                }
              },
              versionNegotiation: { mode: "auto" }
            }
      )
      if (elicitation !== undefined) {
        client.setRequestHandler("elicitation/create", async (request) => {
          elicitation.asked.push(request.params.message)
          if (request.params.mode === "url") elicitation.opened?.push(request.params.url)
          return elicitation.action === "accept"
            ? { action: "accept", content: elicitation.content ?? {} }
            : { action: elicitation.action }
        })
      }
      await client.connect(transport)
      return client
    }),
    (client) => Effect.promise(() => client.close())
  )
})

export const mcpJson = Effect.fnUntraced(function* (client: Client, name: string, arguments_: typeof JsonBody.Type) {
  const result = yield* Effect.promise(() => client.callTool({ name, arguments: arguments_ }))
  expect(result.isError, `${name}: ${mcpText(result)}`).not.toBe(true)
  return Schema.decodeUnknownSync(JsonBody)(result.structuredContent)
})

const decodeName = Schema.decodeUnknownOption(Schema.String)

/** One 2026-07-28 request, sent as a client the SDK does not model yet would send it (the Tasks extension). */
export const rawMcp = (
  handle: (request: Request) => Promise<Response>,
  secret: string,
  capabilities: Record<string, typeof Schema.Json.Type>
) =>
  Effect.fnUntraced(function* (method: string, params: Record<string, typeof Schema.Json.Type>) {
    const name = Option.getOrUndefined(decodeName(params["name"] ?? params["taskId"]))
    const response = yield* Effect.promise(() =>
      handle(
        new Request("http://gateway.test/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
            ...whenPresent("mcp-name", name)
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: {
              ...params,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { name: "raw-client", version: "1" },
                "io.modelcontextprotocol/clientCapabilities": capabilities
              }
            }
          })
        })
      )
    )
    const text = yield* Effect.promise(() => response.text())
    const payload = text.includes("data:")
      ? (text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .pop() ?? "{}")
      : text
    return Schema.decodeUnknownSync(JsonBody)(JSON.parse(payload))
  })
