import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import type { Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { createMcpHandler, fromJsonSchema, inputRequired, inputResponse, McpServer } from "@modelcontextprotocol/server"
import { BlobStore, defaultUrlPolicy, Egress, integrationLayer, temporarySqlLayer } from "@integragents/host"
import { nativeConnect } from "@integragents/host/native-egress"
import { gatewayStore, testEncryption, testServices } from "./fixtures.ts"
import {
  aliasForConnection,
  ConnectionName,
  createGatewayHandler,
  defaultTenantId,
  generateApiKey,
  IntegrationSlug,
  makeGatewayEvents,
  newProfileId,
  ToolName
} from "./gateway.ts"
import type { ConnectionRef, ProfileId } from "./gateway.ts"

const JsonBody = Schema.Record(Schema.String, Schema.Json)
const ToolText = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  isError: Schema.optional(Schema.Boolean)
})
const RoundResult = Schema.Struct({
  resultType: Schema.Literal("input_required"),
  inputRequests: Schema.Record(Schema.String, Schema.Json),
  requestState: Schema.String
})

const textOf = (result: typeof ToolText.Encoded) =>
  Schema.decodeUnknownSync(ToolText)(result)
    .content.map((block) => block.text ?? "")
    .join("")

/** A 2026-07-28 server whose `greet` asks for a name before it answers, as `input_required` rounds do. */
const upstreamServer = Effect.acquireRelease(
  Effect.sync(() => {
    const runs: Array<typeof Schema.Json.Type> = []
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "Greeter", version: "1" })
      server.registerTool(
        "greet",
        {
          description: "Greets someone by the name a human gives",
          inputSchema: fromJsonSchema<{ readonly who?: string }>({
            type: "object",
            properties: { who: { type: "string" } }
          })
        },
        async (arguments_, context) => {
          runs.push({ ...arguments_ })
          const answer = inputResponse(context.mcpReq.inputResponses, "name")
          if (answer.kind !== "elicit") {
            return inputRequired({
              inputRequests: {
                name: inputRequired.elicit({
                  message: "Your name?",
                  requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
                })
              },
              requestState: `asked-for-${arguments_.who ?? "nobody"}`
            })
          }
          const name = answer.action === "accept" ? String(answer.content?.["name"]) : "stranger"
          return {
            content: [
              { type: "text", text: `hello ${name}, from ${arguments_.who} (${context.mcpReq.requestState()})` }
            ]
          }
        }
      )
      return server
    })
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler.fetch(request) })
    return { server, runs }
  }),
  ({ server }) => Effect.promise(() => server.stop(true))
).pipe(Effect.map(({ server, runs }) => ({ endpoint: `http://127.0.0.1:${server.port}/mcp`, runs })))

const integrationServices = Layer.build(
  integrationLayer({ encryption: testEncryption, blobs: BlobStore.sqlLayer }).pipe(
    Layer.provideMerge(Egress.layer(defaultUrlPolicy, nativeConnect(defaultUrlPolicy))),
    Layer.provide(temporarySqlLayer)
  )
)

const setup = Effect.fnUntraced(function* (decision: "allow" | "require_approval") {
  const upstream = yield* upstreamServer
  const store = yield* gatewayStore("gateway-mcp-input-")
  const services = yield* integrationServices
  const { handle } = createGatewayHandler({
    events: yield* makeGatewayEvents,
    httpClient: FetchHttpClient.layer,
    store,
    integrationServices: services,
    retentionDays: 30,
    oauth: {
      start: () => Effect.die(new Error("not used")),
      provideClient: () => Effect.sync((): undefined => undefined),
      get: () => Effect.sync((): undefined => undefined),
      completeByState: () => Effect.sync((): undefined => undefined),
      stop: () => Effect.void
    }
  })
  const keyFor = Effect.fnUntraced(function* (profileId: ProfileId) {
    const key = yield* generateApiKey
    yield* store.addApiKey({ id: key.id, profileId, name: "Claude Desktop", hash: key.hash })
    return key.secret
  })
  const provisioner = yield* store.createProfile({
    id: yield* newProfileId,
    tenantId: defaultTenantId,
    name: "provisioner",
    capabilities: ["provision_connections"],
    tools: []
  })
  const provisionerKey = yield* keyFor(provisioner.id)
  const discovered = yield* Effect.promise(() =>
    handle(
      new Request("http://gateway.test/v1/integrations/discover", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${provisionerKey}` },
        body: JSON.stringify({ url: upstream.endpoint, slug: "greeter" })
      })
    )
  )
  expect(discovered.status).toBe(201)
  const connection: ConnectionRef = {
    owner: "org",
    integration: IntegrationSlug.make("greeter"),
    name: ConnectionName.make("default")
  }
  const profile = yield* store.createProfile({
    id: yield* newProfileId,
    tenantId: defaultTenantId,
    name: "agent",
    capabilities: [],
    approvalMethod: "elicitation",
    tools: [{ connection, tool: ToolName.make("greet"), decision }]
  })
  const secret = yield* keyFor(profile.id)
  const execute = (arguments_: typeof Schema.Json.Type) =>
    Effect.promise(async () => {
      const response = await handle(
        new Request("http://gateway.test/v1/execute", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
          body: JSON.stringify({ alias: aliasForConnection(connection), tool: "greet", arguments: arguments_ })
        })
      )
      return { status: response.status, body: Schema.decodeUnknownSync(JsonBody)(await response.json()) }
    })
  return { handle, store, secret, upstream, execute, tool: `${aliasForConnection(connection)}__greet` }
})

/**
 * A 2026-07-28 client. With `answers` it fulfils every form the way an MCP
 * host does, keyed by the form's message; without, it hands each round back.
 */
const mcpClient = (
  handle: (request: Request) => Promise<Response>,
  secret: string,
  options: {
    readonly elicitation: boolean
    readonly answers?: Record<string, Record<string, string>>
    readonly asked?: Array<string>
  }
): Effect.Effect<Client, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const client = new Client(
        { name: "gateway-test", version: "1.0.0" },
        {
          capabilities: options.elicitation ? { elicitation: { form: {} } } : {},
          versionNegotiation: { mode: { pin: "2026-07-28" } },
          inputRequired: { autoFulfill: options.answers !== undefined }
        }
      )
      if (options.elicitation) {
        client.setRequestHandler("elicitation/create", async (request) => {
          options.asked?.push(request.params.message)
          return { action: "accept", content: options.answers?.[request.params.message] ?? {} }
        })
      }
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://gateway.test/mcp"), {
          authProvider: { token: async () => secret },
          fetch: (input, init) => handle(new Request(input, init))
        })
      )
      return client
    }),
    (client) => Effect.promise(() => client.close())
  )

describe("relaying an upstream server's input requests", () => {
  it.effect("forwards the form to a modern client and finishes the call with its answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handle, store, secret, upstream, tool } = yield* setup("allow")
        const asked: Array<string> = []
        const client = yield* mcpClient(handle, secret, {
          elicitation: true,
          answers: { "Your name?": { name: "Ada" } },
          asked
        })

        const result = yield* Effect.promise(() => client.callTool({ name: tool, arguments: { who: "w" } }))

        expect(textOf(result)).toContain("hello Ada, from w (asked-for-w)")
        expect(asked).toEqual(["Your name?"])
        expect(upstream.runs).toEqual([{ who: "w" }, { who: "w" }])
        expect((yield* store.listAudit(defaultTenantId, {})).map((record) => [record.tool, record.outcome])).toEqual([
          ["greet", "succeeded"]
        ])
      })
    ).pipe(Effect.provide(testServices))
  )

  it.effect("asks for approval once across the rounds of an approval-gated call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handle, store, secret, upstream, tool } = yield* setup("require_approval")
        const asked: Array<string> = []
        const client = yield* mcpClient(handle, secret, {
          elicitation: true,
          answers: { "Your name?": { name: "Ada" } },
          asked
        })

        const result = yield* Effect.promise(() => client.callTool({ name: tool, arguments: { who: "w" } }))

        expect(textOf(result)).toContain("hello Ada")
        expect(asked).toEqual([expect.stringContaining("Approve org___greeter___default.greet?"), "Your name?"])
        expect(upstream.runs).toEqual([{ who: "w" }, { who: "w" }])
        const audit = yield* store.listAudit(defaultTenantId, {})
        expect(audit.filter((record) => record.outcome === "succeeded").map((record) => record.approval)).toEqual([
          "approved"
        ])
        expect(yield* store.listApprovals(defaultTenantId)).toMatchObject([{ status: "approved" }])
      })
    ).pipe(Effect.provide(testServices))
  )

  it.effect("refuses a request state that was altered or minted for other arguments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handle, secret, upstream, tool } = yield* setup("allow")
        const client = yield* mcpClient(handle, secret, { elicitation: true })
        const answer = { "upstream/name": { action: "accept", content: { name: "Mallory" } } }

        const round = Schema.decodeUnknownSync(RoundResult)(
          yield* Effect.promise(() =>
            client.callTool({ name: tool, arguments: { who: "w" } }, { allowInputRequired: true })
          )
        )
        expect(Object.keys(round.inputRequests)).toEqual(["upstream/name"])
        const tampered = `${round.requestState.slice(0, -4)}AAAA`
        const attempts = [
          { arguments: { who: "w" }, requestState: tampered },
          { arguments: { who: "someone else" }, requestState: round.requestState },
          { arguments: { who: "w" }, requestState: "asked-for-w" }
        ]
        for (const attempt of attempts) {
          const retry = {
            name: tool,
            arguments: attempt.arguments,
            inputResponses: answer,
            requestState: attempt.requestState
          }
          const refused = yield* Effect.promise(() => client.callTool(retry, { allowInputRequired: true }))
          expect(Schema.decodeUnknownSync(ToolText)(refused).isError).toBe(true)
          expect(textOf(Schema.decodeUnknownSync(ToolText)(refused))).toContain(
            "requestState does not belong to this call"
          )
        }
        expect(upstream.runs).toEqual([{ who: "w" }])
      })
    ).pipe(Effect.provide(testServices))
  )

  it.effect("tells a caller that cannot answer forms what the tool needs instead", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handle, secret, upstream, execute, tool } = yield* setup("allow")
        const fallback = "Only an MCP client that supports elicitation (protocol 2026-07-28) can answer it"

        const overHttp = yield* execute({ who: "w" })
        expect(overHttp.status).toBe(502)
        expect(overHttp.body).toMatchObject({ status: "failed" })
        expect(String(overHttp.body["message"])).toContain("This tool needs interactive input (Your name?)")
        expect(String(overHttp.body["message"])).toContain(fallback)

        const formless = yield* mcpClient(handle, secret, { elicitation: false })
        const overMcp = Schema.decodeUnknownSync(ToolText)(
          yield* Effect.promise(() => formless.callTool({ name: tool, arguments: { who: "w" } }))
        )
        expect(overMcp.isError).toBe(true)
        expect(textOf(overMcp)).toContain(fallback)
        expect(upstream.runs).toEqual([{ who: "w" }, { who: "w" }])
      })
    ).pipe(Effect.provide(testServices))
  )
})
