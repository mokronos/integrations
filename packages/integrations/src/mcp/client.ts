import type { Client } from "@modelcontextprotocol/client"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { McpError } from "../errors.ts"
import { Egress, gatewayUserAgent } from "../egress/egress.ts"
import { OAuthProtocol } from "../oauth/protocol.ts"
import { whenPresent } from "@integragents/contracts"
import { isJsonObject, type Json, type JsonObject } from "@integragents/contracts"
import { InputRequests, McpEra } from "@integragents/contracts"
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
  annotations: Schema.optional(McpToolAnnotations)
})
export type McpToolDefinition = typeof McpToolDefinition.Type

const decodeTools = Schema.decodeUnknownEffect(Schema.Array(McpToolDefinition))
const decodeJson = Schema.decodeUnknownEffect(Schema.Json)

export interface McpToolListing {
  readonly tools: ReadonlyArray<McpToolDefinition>
  readonly era: McpEra
}

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
                .run(async (open) => (await open.listTools()).tools)
                .pipe(Effect.catchTag("SessionFailure", asMcpError(server.endpoint, Option.some("tools/list"))))
              const tools = yield* decodeTools(listed).pipe(
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
              return { tools, era }
            })
          )
      )

      const probe = Effect.fn("McpClient.probe")(probeServer(client, protocol, egress.fetch))

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
              .run((open) =>
                open.callTool(
                  {
                    name: tool,
                    ...whenPresent("arguments", callArguments(input)),
                    ...whenPresent("inputResponses", answer?.inputResponses),
                    ...whenPresent("requestState", answer?.requestState)
                  },
                  { allowInputRequired: true }
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

      return { probe, listTools, callTool }
    })
  ).pipe(Layer.provide(OAuthProtocol.layer))
}
