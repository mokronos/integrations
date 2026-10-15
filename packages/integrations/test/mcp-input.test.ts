import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import {
  fromJsonSchema,
  inputRequired,
  inputResponse,
  McpServer,
  WebStandardStreamableHTTPServerTransport
} from "@modelcontextprotocol/server"
import { Egress } from "../src/egress/egress.ts"
import { defaultUrlPolicy } from "../src/egress/url-policy.ts"
import { McpClient } from "../src/mcp/client.ts"

/**
 * A 2025-era server that keeps sessions, so its `greet` can push
 * `elicitation/create` to the client mid-call, and gives up when declined.
 */
const legacyServer = Effect.acquireRelease(
  Effect.sync(() => {
    const answers: Array<string> = []
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
    const open = async () => {
      const server = new McpServer({ name: "Greeter", version: "1" })
      server.registerTool(
        "greet",
        {
          description: "Greets someone by the name a human gives",
          inputSchema: fromJsonSchema({ type: "object", properties: {} })
        },
        async (_arguments, context) => {
          const answer = inputResponse(context.mcpReq.inputResponses, "name")
          if (answer.kind !== "elicit") {
            return inputRequired({
              inputRequests: {
                name: inputRequired.elicit({
                  message: "Your name?",
                  requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
                })
              }
            })
          }
          answers.push(answer.action)
          return { content: [{ type: "text", text: "No name was given" }], isError: true }
        }
      )
      const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport)
        }
      })
      await server.connect(transport)
      return transport
    }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const session = request.headers.get("mcp-session-id")
        const transport = session === null ? await open() : sessions.get(session)
        return transport === undefined ? new Response(null, { status: 404 }) : transport.handleRequest(request)
      }
    })
    return { server, answers }
  }),
  ({ server }) => Effect.promise(() => server.stop(true))
).pipe(Effect.map(({ server, answers }) => ({ endpoint: `http://127.0.0.1:${server.port}/mcp`, answers })))

const services = McpClient.layer.pipe(Layer.provide(Egress.layer(defaultUrlPolicy)))

describe("input a 2025-era server asks for mid-call", () => {
  it.live("is declined, and the call reports what the server asked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { endpoint, answers } = yield* legacyServer
        const mcp = yield* McpClient

        const called = yield* mcp.callTool({ endpoint, era: Option.some("legacy") }, Option.none(), "greet", {})

        expect(answers).toEqual(["decline"])
        expect(called).toEqual({
          kind: "complete",
          result: { content: [{ type: "text", text: "No name was given" }], isError: true },
          declined: ["Your name?"]
        })
      })
    ).pipe(Effect.provide(services))
  )
})
