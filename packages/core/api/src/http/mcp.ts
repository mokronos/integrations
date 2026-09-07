import {
  createMcpHandler,
  fromJsonSchema,
  McpServer
} from "@modelcontextprotocol/server"
import {
  Alias,
  asJson,
  type Json,
  isJsonObject,
  objectEntries,
  ToolName,
  whenPresent,
  whenPresentMap
} from "@mokronos/contracts"
import {
  authenticateClient,
  ClientId,
  deliverDueApprovalNotifications,
  invokeThroughGateway,
  listEffectiveTools
} from "@mokronos/gateway-core"
import type { InvocationOutcome } from "@mokronos/gateway-core"
import type { GatewayStore } from "@mokronos/gateway-core"
import { IntegrationHost } from "@mokronos/integrations"
import type { HostServices } from "@mokronos/integrations"
import { Context } from "effect"

/** The one host service the MCP surface reaches for. */
const hostOf = (options: McpGatewayOptions): IntegrationHost["Service"] =>
  Context.get(options.hostServices, IntegrationHost)
import { Layer, ManagedRuntime } from "effect"
import { capture, ErrorCapture } from "./observability.ts"
import type { ErrorSink } from "./observability.ts"
import { gatewayVersion } from "../version.ts"

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

const toolResult = (outcome: InvocationOutcome) => {
  const text = JSON.stringify(outcome)
  return outcome.status === "succeeded"
    ? { content: [{ type: "text" as const, text }] }
    : { content: [{ type: "text" as const, text }], isError: true }
}

/** One invocation, as an Effect. Nothing here runs it: the caller runs it on
 *  the handler's own runtime, so a request shares the gateway's error sink and
 *  its tracing rather than starting from nothing. */
const invocation = (options: McpGatewayOptions, input: {
  readonly secret: string
  readonly alias: Alias
  readonly tool: ToolName
  readonly arguments: Json
}) => invokeThroughGateway(
  {
    store: options.store,
    host: hostOf(options),
    argumentRetentionDays: options.retentionDays,
    approvalUrlOf: (approvalId) => {
      const origin = options.dashboardUrl?.()
      return origin === undefined
        ? undefined
        : `${origin.replace(/\/+$/, "")}/approvals?approval=${encodeURIComponent(approvalId)}`
    },
    // Was `.pipe(Effect.orDie)`: a notification the gateway could not deliver
    // vanished. It still must not fail the invocation — the call is authorized
    // either way — so it is recorded and given a correlation id instead.
    onApprovalCreated: () => capture(deliverDueApprovalNotifications({
      store: options.store,
      ...whenPresentMap("dashboardUrl", options.dashboardUrl?.(), (url) => url)
    }))
  },
  input
)

export interface McpGatewayOptions {
  readonly store: GatewayStore
  readonly hostServices: Context.Context<HostServices>
  readonly retentionDays: number
  readonly dashboardUrl?: () => string | undefined
  /** Shared with the HTTP surface, so a failure on the MCP endpoint is recorded
   *  in the same place and under the same shape of id as one on `/v1`. */
  readonly errorCapture?: ErrorSink
}

/** What the MCP surface runs on.
 *
 *  One runtime for the handler's lifetime rather than a fresh `Effect.runPromise`
 *  per call: the agent-facing endpoint is the busiest path in the gateway, and
 *  every invocation on it now shares one error sink, one set of fiber refs and
 *  one tracing context. `dispose` tears it down with the handler. */
type McpRuntime = ManagedRuntime.ManagedRuntime<ErrorCapture, never>

const serverFor = async (
  options: McpGatewayOptions,
  runtime: McpRuntime,
  clientId: ClientId,
  secret: string
): Promise<McpServer> => {
  const server = new McpServer({ name: "integrations-gateway", version: gatewayVersion })
  const tools = await runtime.runPromise(capture(listEffectiveTools(options.store, clientId, {
    schemas: true,
    host: hostOf(options)
  })))

  for (const tool of tools) {
    const inputSchema = tool.inputSchema !== undefined && isJsonObject(tool.inputSchema)
      ? objectEntries(tool.inputSchema)
      : defaultInputSchema
    server.registerTool(
      toolName(tool.alias, tool.tool),
      {
        title: `${tool.connection.integration} / ${tool.connection.name} / ${tool.tool}`,
        ...whenPresent("description", tool.description),
        inputSchema: fromJsonSchema<Record<string, Json>>(
          inputSchema
        )
      },
      async (arguments_) => toolResult(await runtime.runPromise(capture(invocation(options, {
        secret,
        alias: tool.alias,
        tool: tool.tool,
        arguments: asJson(arguments_)
      }))))
    )
  }
  return server
}

export interface McpGatewayHandle {
  handle(request: Request): Promise<Response>
  dispose(): Promise<void>
}

export const createMcpGatewayHandler = (options: McpGatewayOptions): McpGatewayHandle => {
  const runtime: McpRuntime = ManagedRuntime.make(
    options.errorCapture === undefined
      ? ErrorCapture.logging
      : Layer.succeed(ErrorCapture, options.errorCapture)
  )
  const handler = createMcpHandler(({ authInfo }) => {
    // `createMcpHandler` only calls this once authentication has produced an
    // identity, so an absent one is our bug rather than the caller's. It stays
    // a throw because the SDK's callback is Promise-shaped and this is the one
    // place the two conventions meet.
    if (authInfo === undefined) throw new Error("Authenticated MCP request has no identity")
    return serverFor(options, runtime, ClientId.make(authInfo.clientId), authInfo.token)
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
          scopes: []
        }
      })
    },
    dispose: async () => {
      await handler.close()
      await runtime.dispose()
    }
  }
}
