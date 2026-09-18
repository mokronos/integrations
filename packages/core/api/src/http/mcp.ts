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
} from "@mokronos/integrations-contracts"
import type { Client, Json, PolicyDecision } from "@mokronos/integrations-contracts"
import { Integrations } from "@mokronos/integrations-host"
import type { IntegrationServices } from "@mokronos/integrations-host"
import { authenticateClient, GatewayStoreService, listEffectiveTools } from "@mokronos/integrations-gateway-core"
import type { GatewayStore } from "@mokronos/integrations-gateway-core"
import type { OAuthActor } from "@mokronos/integrations-gateway-core"
import { Context, Effect, Layer, ManagedRuntime, Predicate } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { agentTools, invokeTool } from "./mcp-tools.ts"
import type { AgentTool, McpCaller, ToolOutput } from "./mcp-tools.ts"
import { capture, ErrorCapture } from "./observability.ts"
import type { ErrorSink } from "./observability.ts"
import type { GatewayOperationServices } from "./operations.ts"
import { GatewayConfig } from "./services.ts"
import { OAuthFlowSessions } from "@mokronos/integrations-gateway-core"
import type { GatewaySettings } from "./services.ts"
import { gatewayVersion } from "../version.ts"

/**
 * MCP is a second surface over the same gateway, not a second gateway: its
 * tools call the operations the HTTP routes call, with the client the key
 * authenticated as, so policy, approval, and audit are shared by construction.
 */

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

const explains = (failure: Error): failure is Error & { readonly error: string } =>
  "error" in failure && Predicate.isString(failure.error) && failure.error.length > 0

const describeFailure = (failure: Error): string =>
  failure.message.length > 0 ? failure.message : explains(failure) ? failure.error : String(failure)

const contentOf = (text: string, isError: boolean) => ({
  content: [{ type: "text" as const, text }],
  isError
})

type McpRuntime = ManagedRuntime.ManagedRuntime<GatewayOperationServices, never>

const resultOf = (
  runtime: McpRuntime,
  effect: Effect.Effect<ToolOutput, Error, GatewayOperationServices>
) =>
  runtime.runPromise(Effect.match(effect, {
    onSuccess: (output: ToolOutput) => contentOf(JSON.stringify(output.value), output.failed),
    onFailure: (failure: Error) => contentOf(describeFailure(failure), true)
  }))

export interface McpGatewayOptions {
  readonly store: GatewayStore
  readonly services: Context.Context<GatewayStoreService | IntegrationServices | OAuthFlowSessions>
  readonly settings: GatewaySettings
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
  readonly errorCapture?: ErrorSink
  readonly oauth?: {
    readonly authenticate: (token: string) => Promise<{
      readonly client: Client
      readonly actor: OAuthActor
      readonly expiresAt: Date
      readonly scope: "mcp"
    } | undefined>
    readonly challenge: (error?: string) => string
  }
}

const registerAgentTool = (
  server: McpServer,
  runtime: McpRuntime,
  caller: McpCaller,
  tool: AgentTool
): void => {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: fromJsonSchema<Record<string, Json>>(tool.inputSchema)
    },
    async (arguments_) => resultOf(runtime, tool.run(caller, asJson(arguments_)))
  )
}

const effectiveToolsOf = (client: Client) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const integrations = yield* Integrations
    return yield* capture(listEffectiveTools(store, client.id, { schemas: true, integrations }))
  })

const serverFor = async (runtime: McpRuntime, client: Client, oauthActor?: OAuthActor): Promise<McpServer> => {
  const server = new McpServer({ name: "integrations-gateway", version: gatewayVersion })
  const caller: McpCaller = { client, ...whenPresent("oauthActor", oauthActor) }

  if (client.mcpSurface === "discovery") {
    for (const tool of agentTools) {
      if (tool.capability === undefined || client.capabilities.includes(tool.capability)) {
        registerAgentTool(server, runtime, caller, tool)
      }
    }
    return server
  }

  const effective = await runtime.runPromise(effectiveToolsOf(client))
  for (const tool of effective) {
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
        resultOf(runtime, invokeTool(caller, {
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
    Layer.succeedContext(options.services),
    Layer.succeed(GatewayConfig, options.settings),
    options.errorCapture === undefined
      ? ErrorCapture.logging
      : Layer.succeed(ErrorCapture, options.errorCapture),
    options.httpClient,
    webCryptoLayer
  ))
  const authenticate = (secret: string) => runtime.runPromise(capture(authenticateClient(options.store, secret)))
  const resolve = async (secret: string) => {
    if (secret.startsWith("wfoa_") && options.oauth !== undefined) {
      const oauth = await options.oauth.authenticate(secret)
      return oauth === undefined ? undefined : { client: oauth.client, actor: oauth.actor, scope: oauth.scope }
    }
    const apiKey = await authenticate(secret)
    return apiKey.status === "authenticated"
      ? { client: apiKey.client, scope: apiKey.client.capabilities.join(" ") }
      : apiKey
  }
  const handler = createMcpHandler(async ({ authInfo }) => {
    if (authInfo === undefined) throw new Error("Authenticated MCP request has no identity")
    const authentication = await resolve(authInfo.token)
    if (authentication === undefined || "status" in authentication) throw new Error("MCP credential is no longer valid")
    return serverFor(runtime, authentication.client, authentication.actor)
  })

  return {
    handle: async (request) => {
      const secret = presentedSecret(request)
      if (secret === undefined || secret.length === 0) {
        return Response.json(
          { error: "An MCP credential is required" },
          { status: 401, headers: { "www-authenticate": options.oauth?.challenge() ?? "Bearer" } }
        )
      }
      const authentication = await resolve(secret)
      if (authentication === undefined) {
        return Response.json(
          { error: "Invalid access token" },
          { status: 401, headers: { "www-authenticate": options.oauth?.challenge("invalid_token") ?? "Bearer" } }
        )
      }
      if ("status" in authentication) {
        return authenticationFailure(authentication.status)
      }
      return handler.fetch(request, {
        authInfo: {
          token: secret,
          clientId: authentication.client.id,
          scopes: authentication.scope.split(" ").filter((scope) => scope.length > 0)
        }
      })
    },
    dispose: async () => {
      await handler.close()
      await runtime.dispose()
    }
  }
}
