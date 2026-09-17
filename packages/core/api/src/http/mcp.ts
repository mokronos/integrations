import {
  createMcpHandler,
  fromJsonSchema,
  McpServer
} from "@modelcontextprotocol/server"
import {
  Alias,
  asJson,
  isJsonObject,
  objectEntries,
  ToolName,
  webCryptoLayer,
  whenPresent
} from "@integrations/contracts"
import type { Client, Json, PolicyDecision } from "@integrations/contracts"
import { authenticateClient } from "@integrations/gateway-core"
import type { GatewayStore } from "@integrations/gateway-core"
import { makeGatewayClient } from "@mokronos/integrations-client"
import type { GatewayClient } from "@mokronos/integrations-client"
import { Crypto, Effect, Layer, ManagedRuntime, Predicate } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { agentTools, invokeTool } from "./mcp-tools.ts"
import type { AgentTool, ToolOutput } from "./mcp-tools.ts"
import { capture, ErrorCapture } from "./observability.ts"
import type { ErrorSink } from "./observability.ts"
import { gatewayVersion } from "../version.ts"

/**
 * MCP is a second surface over the same gateway, not a second gateway: every
 * tool call is an ordinary API request that the handler authenticates, meters,
 * and authorizes exactly as it would one arriving over the network.
 */
export type GatewayDispatch = (request: Request) => Promise<Response>

/** Never resolved: the dispatch answers without the request leaving the process. */
const loopbackOrigin = "http://gateway.mcp.internal"

/** Nothing to warm up when the other end of the socket is this process. */
const loopbackFetch = (dispatch: GatewayDispatch): typeof globalThis.fetch =>
  Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => dispatch(new Request(input, init)),
    { preconnect: () => {} }
  )

const defaultInputSchema = {
  type: "object",
  additionalProperties: true
} as const

const presentedSecret = (request: Request): string | undefined => {
  const authorization = request.headers.get("authorization")
  const bearer = authorization === null
    ? undefined
    : /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1]
  return bearer ?? request.headers.get("x-api-key") ?? undefined
}

const authenticationFailure = (status: "unknown-key" | "key-revoked" | "client-revoked") =>
  Response.json(
    { error: status === "client-revoked" ? "Client revoked" : "Invalid API key" },
    {
      status: status === "client-revoked" ? 403 : 401,
      headers: { "www-authenticate": "Bearer" }
    }
  )

const toolName = (alias: Alias, name: ToolName): string => `${alias}__${name}`

const awaitsApproval = "Calls to this tool are held until a human approves them."

/** The approval decision belongs in the description: the model reads that. */
const describeEffectiveTool = (tool: {
  readonly description?: string | undefined
  readonly decision: PolicyDecision
}): string | undefined =>
  tool.decision !== "require_approval"
    ? tool.description
    : tool.description === undefined
      ? awaitsApproval
      : `${tool.description}\n\n${awaitsApproval}`


// The gateway's routes spell their human-readable text `error`, not `message`,
// so a failure carrying one reads as empty until it is asked for by name.
const explains = (failure: Error): failure is Error & { readonly error: string } =>
  "error" in failure && Predicate.isString(failure.error) && failure.error.length > 0

const describeFailure = (failure: Error): string =>
  failure.message.length > 0 ? failure.message : explains(failure) ? failure.error : String(failure)

const contentOf = (text: string, isError: boolean) => ({
  content: [{ type: "text" as const, text }],
  isError
})

const resultOf = (
  runtime: McpRuntime,
  effect: Effect.Effect<ToolOutput, Error>
) =>
  runtime.runPromise(Effect.match(effect, {
    onSuccess: (output: ToolOutput) => contentOf(JSON.stringify(output.value), output.failed),
    onFailure: (failure: Error) => contentOf(describeFailure(failure), true)
  }))

export interface McpGatewayOptions {
  readonly store: GatewayStore
  readonly dispatch: GatewayDispatch
  readonly errorCapture?: ErrorSink
}

type McpRuntime = ManagedRuntime.ManagedRuntime<
  Crypto.Crypto | ErrorCapture | HttpClient.HttpClient,
  never
>

const registerAgentTool = (
  server: McpServer,
  runtime: McpRuntime,
  client: GatewayClient,
  tool: AgentTool
): void => {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: fromJsonSchema<Record<string, Json>>(tool.inputSchema)
    },
    async (arguments_) => resultOf(runtime, tool.run(client, asJson(arguments_)))
  )
}

const serverFor = async (
  runtime: McpRuntime,
  secret: string,
  identity: Client
): Promise<McpServer> => {
  const server = new McpServer({ name: "integrations-gateway", version: gatewayVersion })
  const client = await runtime.runPromise(
    makeGatewayClient({ url: loopbackOrigin, apiKey: secret })
  )

  if (identity.mcpSurface === "discovery") {
    for (const tool of agentTools) {
      if (tool.capability === undefined || identity.capabilities.includes(tool.capability)) {
        registerAgentTool(server, runtime, client, tool)
      }
    }
    return server
  }

  const effective = await runtime.runPromise(client.delegated.listTools({
    query: { schemas: true }
  }))
  for (const tool of effective.tools) {
    const name = ToolName.make(tool.tool)
    const inputSchema = tool.inputSchema !== undefined && isJsonObject(tool.inputSchema)
      ? objectEntries(tool.inputSchema)
      : defaultInputSchema
    server.registerTool(
      toolName(tool.alias, name),
      {
        title: `${tool.connection.integration} / ${tool.connection.name} / ${tool.tool}`,
        ...whenPresent("description", describeEffectiveTool(tool)),
        inputSchema: fromJsonSchema<Record<string, Json>>(inputSchema)
      },
      async (arguments_) =>
        resultOf(runtime, invokeTool(client, {
          alias: tool.alias,
          tool: name,
          arguments: asJson(arguments_)
        }))
    )
  }
  return server
}

export interface McpGatewayHandle {
  handle(request: Request): Promise<Response>
  dispose(): Promise<void>
}

export const createMcpGatewayHandler = (options: McpGatewayOptions): McpGatewayHandle => {
  const runtime: McpRuntime = ManagedRuntime.make(Layer.mergeAll(
    options.errorCapture === undefined
      ? ErrorCapture.logging
      : Layer.succeed(ErrorCapture, options.errorCapture),
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, loopbackFetch(options.dispatch)))
    ),
    webCryptoLayer
  ))
  const handler = createMcpHandler(async ({ authInfo }) => {
    if (authInfo === undefined) throw new Error("Authenticated MCP request has no identity")
    const authentication = await runtime.runPromise(capture(authenticateClient(options.store, authInfo.token)))
    if (authentication.status !== "authenticated") throw new Error("MCP session key is no longer valid")
    return serverFor(runtime, authInfo.token, authentication.client)
  })

  return {
    handle: async (request) => {
      const secret = presentedSecret(request)
      if (secret === undefined || secret.length === 0) {
        return Response.json(
          { error: "An API key is required" },
          { status: 401, headers: { "www-authenticate": "Bearer" } }
        )
      }
      const authentication = await runtime.runPromise(
        capture(authenticateClient(options.store, secret))
      )
      if (authentication.status !== "authenticated") {
        return authenticationFailure(authentication.status)
      }
      return handler.fetch(request, {
        authInfo: {
          token: secret,
          clientId: authentication.client.id,
          scopes: [...authentication.client.capabilities]
        }
      })
    },
    dispose: async () => {
      await handler.close()
      await runtime.dispose()
    }
  }
}
