import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  fromJsonSchema,
  inputRequired,
  inputResponse,
  McpServer
} from "@modelcontextprotocol/server"
import type { ServerContext } from "@modelcontextprotocol/server"
import {
  Alias,
  asJson,
  isJsonObject,
  objectEntries,
  ToolName,
  webCryptoLayer,
  whenPresent
} from "@integragents/contracts"
import type { Json, Profile, ToolDecision } from "@integragents/contracts"
import { Integrations } from "@integragents/host"
import type { IntegrationServices } from "@integragents/host"
import { authenticateKey, GatewayStoreService, keyOrigin, listEffectiveTools, oauthOrigin } from "@integragents/gateway-core"
import type { ApiKey, GatewayStore, OAuthActor } from "@integragents/gateway-core"
import { Context, Effect, Layer, ManagedRuntime, Option, Predicate, Schema } from "effect"
import { Headers, HttpTraceContext } from "effect/http"
import type { HttpClient } from "effect/http"
import { agentTools, invokeTool } from "./mcp-tools.ts"
import type { AgentTool, ApprovalPrompt, McpCaller, ToolOutput } from "./mcp-tools.ts"
import { capture, ErrorCapture } from "./observability.ts"
import type { ErrorSink } from "./observability.ts"
import type { GatewayOperationServices } from "./operations.ts"
import { GatewayConfig } from "./services.ts"
import { OAuthFlowSessions } from "@integragents/gateway-core"
import type { GatewaySettings } from "./services.ts"
import { gatewayVersion } from "../version.ts"

/**
 * MCP is a second surface over the same gateway, not a second gateway: its
 * tools call the operations the HTTP routes call, with the profile the
 * credential belongs to, so decisions, approval, and audit are shared by construction.
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

const authenticationFailure = (status: "unknown-key" | "key-revoked" | "profile-revoked") =>
  Response.json(
    { error: status === "profile-revoked" ? "Profile revoked" : "Invalid API key" },
    {
      status: status === "profile-revoked" ? 403 : 401,
      headers: { "www-authenticate": "Bearer" }
    }
  )

const toolName = (alias: Alias, name: ToolName): string => `${alias}__${name}`

const awaitsApproval = "Calls to this tool are held until a human approves them."

/** The approval decision belongs in the description: the model reads that. */
const describeEffectiveTool = (tool: {
  readonly description?: string | undefined
  readonly decision: ToolDecision
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

const approvalInput = "approval"

/**
 * Only 2026-07-28 requests carry their client's capabilities, so only they can
 * be answered with an elicitation; older clients fall back to the approval link.
 */
const EnvelopeElicitation = Schema.Struct({
  [CLIENT_CAPABILITIES_META_KEY]: Schema.Struct({
    elicitation: Schema.Struct({ form: Schema.optional(Schema.Json), url: Schema.optional(Schema.Json) })
  })
})
const decodeEnvelopeElicitation = Schema.decodeUnknownOption(EnvelopeElicitation)

/** What the MCP client says it is, such as `claude-code 2.1.0`, recorded with each call it makes. */
const EnvelopeClientInfo = Schema.Struct({
  [CLIENT_INFO_META_KEY]: Schema.Struct({ name: Schema.String, version: Schema.optional(Schema.String) })
})
const decodeEnvelopeClientInfo = Schema.decodeUnknownOption(EnvelopeClientInfo)

const agentOf = (context: ServerContext): string | undefined =>
  Option.getOrUndefined(Option.map(decodeEnvelopeClientInfo(context.mcpReq.envelope), (envelope) => {
    const info = envelope[CLIENT_INFO_META_KEY]
    return info.version === undefined ? info.name : `${info.name} ${info.version}`
  }))

const approvalPromptOf = (context: ServerContext): ApprovalPrompt => {
  const envelope = decodeEnvelopeElicitation(context.mcpReq.envelope)
  const elicitation = Option.getOrUndefined(envelope)?.[CLIENT_CAPABILITIES_META_KEY].elicitation
  if (elicitation === undefined || (elicitation.form === undefined && elicitation.url !== undefined)) {
    return { kind: "unsupported" }
  }
  const answer = inputResponse(context.mcpReq.inputResponses, approvalInput)
  return answer.kind === "elicit" ? { kind: "answered", action: answer.action } : { kind: "unanswered" }
}

const replyOf = (output: ToolOutput) =>
  output.kind === "result"
    ? contentOf(JSON.stringify(output.value), output.failed)
    : inputRequired({
      inputRequests: {
        [approvalInput]: inputRequired.elicit({
          message: output.message,
          requestedSchema: { type: "object", properties: {} }
        })
      }
    })

type McpRuntime = ManagedRuntime.ManagedRuntime<GatewayOperationServices, never>

/** Continues the caller's trace when its request carried one. */
const spanOptionsFor = (request: Request | undefined) =>
  whenPresent(
    "parent",
    request === undefined
      ? undefined
      : Option.getOrUndefined(HttpTraceContext.fromHeaders(Headers.fromInput(request.headers)))
  )

const resultOf = (
  runtime: McpRuntime,
  call: { readonly tool: string; readonly caller: McpCaller; readonly request: Request | undefined },
  effect: Effect.Effect<ToolOutput, Error, GatewayOperationServices>
) =>
  runtime.runPromise(effect.pipe(
    Effect.tap((output) => Effect.annotateCurrentSpan("mcp.tool.outcome", output.kind === "result" ? output.failed ? "failed" : "result" : output.kind)),
    Effect.tapError((failure) =>
      Effect.logInfo("MCP tool call refused", failure).pipe(
        Effect.annotateLogs({ "error.tag": Predicate.hasProperty(failure, "_tag") ? String(failure._tag) : failure.name })
      )),
    Effect.match({
      onSuccess: replyOf,
      onFailure: (failure: Error) => contentOf(describeFailure(failure), true)
    }),
    Effect.withSpan("Mcp.callTool", {
      kind: "server",
      attributes: { "mcp.tool": call.tool, "profile.id": call.caller.profile.id },
      ...spanOptionsFor(call.request)
    })
  ))

export interface McpGatewayOptions {
  readonly store: GatewayStore
  readonly services: Context.Context<GatewayStoreService | IntegrationServices | OAuthFlowSessions>
  readonly settings: GatewaySettings
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
  readonly telemetry: Layer.Layer<never>
  readonly errorCapture?: ErrorSink
  readonly oauth?: {
    readonly authenticate: (token: string) => Promise<{
      readonly profile: Profile
      readonly actor: OAuthActor
      readonly expiresAt: Date
      readonly scope: "mcp"
    } | undefined>
    readonly challenge: (error?: string) => string
  }
}

/** The credential behind an MCP request: one of the profile's keys, or an OAuth app acting for a person. */
type McpPrincipal = {
  readonly profile: Profile
  readonly credential:
    | { readonly kind: "key"; readonly key: ApiKey }
    | { readonly kind: "oauth"; readonly actor: OAuthActor }
}

const callerFor = (principal: McpPrincipal, context: ServerContext): McpCaller => {
  const agent = agentOf(context)
  return {
    profile: principal.profile,
    origin: principal.credential.kind === "key"
      ? keyOrigin(principal.credential.key, agent)
      : oauthOrigin(principal.credential.actor, agent),
    approvalPrompt: approvalPromptOf(context)
  }
}

const registerAgentTool = (
  server: McpServer,
  runtime: McpRuntime,
  principal: McpPrincipal,
  tool: AgentTool
): void => {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: fromJsonSchema<Record<string, Json>>(tool.inputSchema)
    },
    async (arguments_, context) => {
      const caller = callerFor(principal, context)
      return resultOf(runtime, { tool: tool.name, caller, request: context.http?.req }, tool.run(caller, asJson(arguments_)))
    }
  )
}

const effectiveToolsOf = (profile: Profile) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const integrations = yield* Integrations
    return yield* capture(listEffectiveTools(store, profile.id, { schemas: true, integrations }))
  })

const serverFor = async (
  runtime: McpRuntime,
  request: Request | undefined,
  principal: McpPrincipal
): Promise<McpServer> => {
  const server = new McpServer({ name: "integrations-gateway", version: gatewayVersion })
  const profile = principal.profile

  if (profile.mcpSurface === "discovery") {
    for (const tool of agentTools) {
      if (tool.capability === undefined || profile.capabilities.includes(tool.capability)) {
        registerAgentTool(server, runtime, principal, tool)
      }
    }
    return server
  }

  const effective = await runtime.runPromise(effectiveToolsOf(profile).pipe(
    Effect.withSpan("Mcp.listTools", { attributes: { "profile.id": profile.id }, ...spanOptionsFor(request) })
  ))
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
      async (arguments_, context) => {
        const caller = callerFor(principal, context)
        return resultOf(runtime, { tool: toolName(tool.alias, name), caller, request: context.http?.req }, invokeTool(caller, {
          alias: tool.alias,
          tool: name,
          arguments: asJson(arguments_)
        }))
      }
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
    webCryptoLayer,
    options.telemetry
  ))
  const authenticate = (secret: string, request: Request | undefined) =>
    runtime.runPromise(capture(authenticateKey(options.store, secret)).pipe(
      Effect.withSpan("Mcp.authenticate", spanOptionsFor(request))
    ))
  const resolve = async (secret: string, request: Request | undefined) => {
    if (secret.startsWith("igoa_") && options.oauth !== undefined) {
      const oauth = await options.oauth.authenticate(secret)
      return oauth === undefined
        ? undefined
        : { principal: { profile: oauth.profile, credential: { kind: "oauth", actor: oauth.actor } } satisfies McpPrincipal, scope: oauth.scope }
    }
    const apiKey = await authenticate(secret, request)
    return apiKey.status === "authenticated"
      ? {
        principal: { profile: apiKey.profile, credential: { kind: "key", key: apiKey.key } } satisfies McpPrincipal,
        scope: apiKey.profile.capabilities.join(" ")
      }
      : apiKey
  }
  const handler = createMcpHandler(async ({ authInfo, requestInfo }) => {
    if (authInfo === undefined) throw new Error("Authenticated MCP request has no identity")
    const authentication = await resolve(authInfo.token, requestInfo)
    if (authentication === undefined || "status" in authentication) throw new Error("MCP credential is no longer valid")
    return serverFor(runtime, requestInfo, authentication.principal)
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
      const authentication = await resolve(secret, request)
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
          clientId: authentication.principal.profile.id,
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
