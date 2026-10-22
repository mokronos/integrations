import { expect } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { delegationTemplateOf, ToolAddress, whenPresent } from "@integragents/contracts"
import { makeGatewayEvents, publishingStore } from "@integragents/gateway-core"
import type { ApprovalReviewer, OAuthSessions } from "@integragents/gateway-core"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { Connection, ConnectionOwner, Tool } from "@integragents/contracts"
import { InvocationError } from "@integragents/integrations"
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

const stubConnection = (reference: { readonly integration: string; readonly name: string }): Connection => ({
  owner: "user:sebastian",
  name: ConnectionName.make(reference.name),
  integration: IntegrationSlug.make(reference.integration),
  template: reference.integration,
  address: `connections.${reference.integration}.user.${reference.name}`,
  provider: reference.integration,
  status: "connected"
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
  idempotent: tool.defaultDecision === "allow"
})

const stubIntegrations = (
  behaviour: {
    readonly beforeExecute?: () => Promise<void>
    readonly fail?: boolean
    readonly connections?: ReadonlyArray<{ readonly integration: string; readonly name: string }>
    /** Integrations known to the catalog that offer OAuth, connected or not. */
    readonly oauthIntegrations?: ReadonlyArray<string>
    readonly tools?: ReadonlyArray<{
      readonly address: string
      readonly name: string
      readonly owner?: ConnectionOwner
      readonly defaultDecision?: "allow" | "require_approval"
    }>
  } = {}
) => {
  const calls: Array<ExecutedCall> = []
  const removed: Array<{ readonly integration: string; readonly name: string }> = []
  const forgotten: Array<string> = []
  const renamed: Array<{ readonly slug: string; readonly name: string }> = []
  const oauthCapable = new Set(behaviour.oauthIntegrations ?? [])
  const known = new Set([...(behaviour.connections ?? []).map((connection) => connection.integration), ...oauthCapable])
  const integrationServices = stubIntegrationsContext({
    execute: (address, input) => {
      calls.push({ address: String(address), input })
      return Effect.promise(() => behaviour.beforeExecute?.() ?? Promise.resolve()).pipe(
        Effect.flatMap(() =>
          behaviour.fail === true
            ? Effect.fail(
                new InvocationError({
                  code: "upstream_error",
                  detail: "vendor exploded"
                })
              )
            : Effect.succeed({ kind: "complete" as const, result: { ok: true } })
        )
      )
    },
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
        }
      }),
    listConnections: () => Effect.succeed((behaviour.connections ?? []).map(stubConnection)),
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
  })
  return { calls, removed, forgotten, renamed, integrationServices }
}

export const setup = Effect.fnUntraced(function* (
  options: {
    readonly decision?: "allow" | "require_approval"
    readonly capabilities?: ReadonlyArray<"provision_connections" | "administer_gateway">
    readonly mcpSurface?: "tools" | "discovery"
    readonly beforeExecute?: () => Promise<void>
    readonly fail?: boolean
    readonly connections?: ReadonlyArray<{ readonly integration: string; readonly name: string }>
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
    ...whenPresent("connections", options.connections),
    ...whenPresent("tools", options.tools),
    ...whenPresent("oauthIntegrations", options.oauthIntegrations)
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
          : { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: "auto" } }
      )
      if (elicitation !== undefined) {
        client.setRequestHandler("elicitation/create", async (request) => {
          elicitation.asked.push(request.params.message)
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
  return Schema.decodeUnknownSync(JsonBody)(JSON.parse(mcpText(result)))
})
