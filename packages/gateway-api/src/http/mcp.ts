import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  fromJsonSchema,
  inputRequired,
  inputResponse,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError
} from "@modelcontextprotocol/server"
import type {
  CallToolResult,
  InputRequest,
  InputRequiredResult,
  McpHttpHandler,
  McpRequestContext,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations
} from "@modelcontextprotocol/server"
import {
  Alias,
  ApprovalId,
  asJson,
  describeError,
  GatewayError,
  GatewayFailure,
  gatewayVersion,
  InputResponses,
  isJsonObject,
  mcpAppMimeType,
  mcpAppsExtension,
  NotFound,
  objectEntries,
  presentError,
  ToolName,
  Unauthorized,
  webCryptoLayer,
  whenPresent
} from "@integragents/contracts"
import type { InputRequests, Json, Profile, SubjectId, TenantId, ToolDecision } from "@integragents/contracts"
import { Integrations, unrelayableInputMessage } from "@integragents/integrations"
import type { IntegrationServices } from "@integragents/integrations"
import {
  authenticateKey,
  GatewayEvents,
  GatewayStoreService,
  keyOrigin,
  listEffectiveTools,
  oauthOrigin,
  reachableBy
} from "@integragents/gateway-core"
import type { ApiKey, EffectiveTool, GatewayStore, Interaction, OAuthActor } from "@integragents/gateway-core"
import { Cause, Context, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Schema, Stream } from "effect"
import { Headers, HttpTraceContext } from "effect/http"
import type { HttpClient } from "effect/http"
import {
  agentTools,
  approvalDescription,
  approvalForm,
  approvalInputKey,
  decodeApprovalAnswer,
  invokeTool
} from "./mcp-tools.ts"
import { outcomeResult, valueResult } from "./mcp-results.ts"
import { instructionsFor } from "./mcp-instructions.ts"
import { serveResources } from "./mcp-resources.ts"
import { serveSkills } from "./mcp-skills.ts"
import { serveTasks, taskOf, tasksExtension } from "./mcp-tasks.ts"
import { connectionsOf } from "./resources.ts"
import type { ResourceRun } from "./mcp-resources.ts"
import type { AgentTool, ApprovalPrompt, McpCaller, ToolOutput } from "./mcp-tools.ts"
import { capture, ErrorCapture, traceIdFor } from "./observability.ts"
import { refusedKey } from "./identity.ts"
import type { ErrorSink } from "./observability.ts"
import { findProfileApproval } from "./operations.ts"
import type { GatewayOperationServices } from "./operations.ts"
import { GatewayConfig } from "./services.ts"
import { OAuthFlowSessions } from "@integragents/gateway-core"
import type { GatewaySettings } from "./services.ts"

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
  const bearer = authorization === null ? undefined : /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1]
  return bearer ?? request.headers.get("x-api-key") ?? undefined
}

const encodeError = Schema.encodeSync(GatewayError)

const errorResponse = (error: GatewayError, challenge: string) =>
  Response.json(encodeError(error), {
    status: presentError(error).status,
    headers: { "www-authenticate": challenge }
  })

const decodeArguments = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

/**
 * Advertises `schema` and leaves checking the arguments against it to the
 * gateway, which reports every failing path rather than the SDK's one line.
 */
const checkedByGateway = (schema: Record<string, Json>): StandardSchemaWithJSON<Record<string, Json>> => ({
  "~standard": {
    version: 1,
    vendor: "integrations-gateway",
    jsonSchema: { input: () => schema, output: () => schema },
    validate: (value) =>
      Option.match(decodeArguments(value ?? {}), {
        onNone: () => ({ issues: [{ message: "Tool arguments must be a JSON object" }] }),
        onSome: (decoded) => ({ value: decoded })
      })
  }
})

/**
 * The tool's own output schema, advertised as its source declared it. The
 * gateway passes the upstream's structured content on unchanged, so whether it
 * fits is the upstream's promise, not something to fail the call over here.
 */
const declaredBySource = (schema: Record<string, Json>): StandardSchemaWithJSON<Json> => ({
  "~standard": {
    version: 1,
    vendor: "integrations-gateway",
    jsonSchema: { input: () => schema, output: () => schema },
    validate: (value) => ({ value: asJson(value ?? null) })
  }
})

/** MCP requires an object at an output schema's root; anything else is not advertised. */
const outputSchemaOf = (schema: Json | undefined): StandardSchemaWithJSON<Json> | undefined =>
  schema !== undefined && isJsonObject(schema) && schema["type"] === "object"
    ? declaredBySource(objectEntries(schema))
    : undefined

const toolName = (alias: Alias, name: ToolName): string => `${alias}__${name}`

/** The approval decision belongs in the description: the model reads that. */
const describeEffectiveTool = (tool: {
  readonly description?: string | undefined
  readonly decision: ToolDecision
}): string | undefined => {
  const approval = approvalDescription(tool.decision)
  return approval === undefined
    ? tool.description
    : tool.description === undefined
      ? approval
      : `${tool.description}\n\n${approval}`
}

const contentOf = (text: string, isError: boolean): CallToolResult => ({
  content: [{ type: "text", text }],
  isError
})

/** The error as agents read it, with the same fields in structured form for clients that parse them. */
const errorResultOf = (error: GatewayError) => ({
  content: [{ type: "text" as const, text: describeError(error) }],
  structuredContent: { error: encodeError(error) },
  isError: true
})

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

const EnvelopeExtensions = Schema.Struct({
  [CLIENT_CAPABILITIES_META_KEY]: Schema.Struct({ extensions: Schema.Record(Schema.String, Schema.Json) })
})
const decodeEnvelopeExtensions = Schema.decodeUnknownOption(EnvelopeExtensions)

/** Whether the client declared an extension on this request; only 2026-07-28 requests carry the declaration. */
const declaresExtension = (context: ServerContext, extension: string): boolean =>
  Option.exists(
    decodeEnvelopeExtensions(context.mcpReq.envelope),
    (envelope) => extension in envelope[CLIENT_CAPABILITIES_META_KEY].extensions
  )

/** What the MCP client says it is, such as `claude-code 2.1.0`, recorded with each call it makes. */
const EnvelopeClientInfo = Schema.Struct({
  [CLIENT_INFO_META_KEY]: Schema.Struct({ name: Schema.String, version: Schema.optional(Schema.String) })
})
const decodeEnvelopeClientInfo = Schema.decodeUnknownOption(EnvelopeClientInfo)

const agentOf = (context: ServerContext): string | undefined =>
  Option.getOrUndefined(
    Option.map(decodeEnvelopeClientInfo(context.mcpReq.envelope), (envelope) => {
      const info = envelope[CLIENT_INFO_META_KEY]
      return info.version === undefined ? info.name : `${info.name} ${info.version}`
    })
  )

/** An empty `elicitation` capability is the 2025-06-18 spelling of form support. */
const elicitationOf = (context: ServerContext): McpCaller["elicitation"] => {
  const declared = Option.getOrUndefined(decodeEnvelopeElicitation(context.mcpReq.envelope))?.[
    CLIENT_CAPABILITIES_META_KEY
  ].elicitation
  return declared === undefined
    ? { form: false, url: false }
    : { form: declared.form !== undefined || declared.url === undefined, url: declared.url !== undefined }
}

const approvalPromptOf = (context: ServerContext): ApprovalPrompt => {
  if (!elicitationOf(context).form) return { kind: "unsupported" }
  const answer = inputResponse(context.mcpReq.inputResponses, approvalInputKey)
  if (answer.kind !== "elicit") return { kind: "unanswered" }
  if (answer.action !== "accept") return { kind: "answered", action: answer.action, remember: false }
  return Option.match(decodeApprovalAnswer(answer.content ?? {}), {
    onNone: (): ApprovalPrompt => ({ kind: "malformed" }),
    onSome: ({ remember }): ApprovalPrompt => ({ kind: "answered", action: "accept", remember: remember === true })
  })
}

/** An upstream server's input requests ride under their own prefix, apart from the gateway's own keys. */
const upstreamInputPrefix = "upstream/"

const decodeInputResponses = Schema.decodeUnknownOption(InputResponses)
const decodeRequestState = Schema.decodeUnknownOption(Schema.String)

/**
 * A client that can answer an elicitation can answer the upstream's rounds
 * too. When it calls again with `requestState`, its answers to the upstream
 * keys go back without their prefix.
 */
const interactionOf = (context: ServerContext): Interaction => {
  const elicitation = elicitationOf(context)
  const relay = elicitation.form || elicitation.url
  const requestState = Option.getOrUndefined(decodeRequestState(context.mcpReq.requestState()))
  if (requestState === undefined) return { relay }
  const responses = Option.getOrElse(decodeInputResponses(context.mcpReq.inputResponses), (): InputResponses => ({}))
  const upstream = Object.fromEntries(
    Object.entries(responses).flatMap(([key, value]) =>
      key.startsWith(upstreamInputPrefix) ? [[key.slice(upstreamInputPrefix.length), value]] : []
    )
  )
  return { relay, answer: { inputResponses: upstream, requestState } }
}

const UpstreamFormElicitation = Schema.Struct({
  method: Schema.Literal("elicitation/create"),
  params: Schema.Struct({
    mode: Schema.optional(Schema.Literal("form")),
    message: Schema.String,
    requestedSchema: Schema.Record(Schema.String, Schema.Json)
  })
})
const UpstreamUrlElicitation = Schema.Struct({
  method: Schema.Literal("elicitation/create"),
  params: Schema.Struct({ mode: Schema.Literal("url"), message: Schema.String, url: Schema.String })
})
const decodeUpstreamForm = Schema.decodeUnknownOption(UpstreamFormElicitation)
const decodeUpstreamUrl = Schema.decodeUnknownOption(UpstreamUrlElicitation)

/**
 * An upstream's request goes to the human only in a mode their client said it
 * can show. The SDK re-checks a form against what elicitation may ask.
 */
const relayedRequest = (request: Json, elicitation: McpCaller["elicitation"]): Option.Option<InputRequest> =>
  Option.orElse(
    Option.flatMap(
      Option.filter(decodeUpstreamForm(request), () => elicitation.form),
      ({ params }) =>
        Option.liftThrowable(() =>
          inputRequired.elicit({
            message: params.message,
            requestedSchema: fromJsonSchema<Record<string, Json>>(params.requestedSchema)
          })
        )()
    ),
    () =>
      Option.map(
        Option.filter(decodeUpstreamUrl(request), () => elicitation.url),
        ({ params }) => inputRequired.elicitUrl({ message: params.message, url: params.url })
      )
  )

const relayedRound = (requests: InputRequests, requestState: string, elicitation: McpCaller["elicitation"]) => {
  const relayed = Object.entries(requests).map(
    ([key, request]) => [`${upstreamInputPrefix}${key}`, relayedRequest(request, elicitation)] as const
  )
  return relayed.every(([, request]) => Option.isSome(request))
    ? inputRequired({
        inputRequests: Object.fromEntries(
          relayed.flatMap(([key, request]) => (Option.isSome(request) ? [[key, request.value]] : []))
        ),
        requestState
      })
    : contentOf(unrelayableInputMessage(requests), true)
}

type ToolReply = CallToolResult | InputRequiredResult

/** A task in the shape `tools/call` answers with: the extension's `resultType`, and the content every result carries. */
const taskReply = (caller: McpCaller, approvalId: ApprovalId) =>
  Effect.gen(function* () {
    const approval = yield* findProfileApproval(caller.profile, approvalId)
    if (approval === undefined) return yield* new NotFound({ resource: "approval", id: approvalId })
    const task = yield* taskOf(caller, approval)
    return { content: [], ...task, resultType: "task" } satisfies ToolReply
  })

const replyOf = (
  output: ToolOutput,
  caller: McpCaller
): Effect.Effect<ToolReply, GatewayError, GatewayOperationServices> => {
  switch (output.kind) {
    case "task":
      return taskReply(caller, output.approvalId)
    case "result":
      return Effect.succeed(valueResult(output.value, output.failed))
    case "outcome":
      return outcomeResult(output.alias, output.outcome)
    case "ask-approval":
      return Effect.succeed(
        inputRequired({
          inputRequests: {
            [approvalInputKey]: inputRequired.elicit({ message: output.message, requestedSchema: approvalForm })
          }
        })
      )
    case "ask-url":
      return Effect.succeed(
        inputRequired({
          inputRequests: { [output.key]: inputRequired.elicitUrl({ message: output.message, url: output.url }) },
          ...whenPresent("requestState", output.requestState)
        })
      )
    case "input-required":
      return Effect.succeed(relayedRound(output.inputRequests, output.requestState, caller.elicitation))
  }
}

type McpRuntime = ManagedRuntime.ManagedRuntime<GatewayOperationServices | GatewayEvents, never>

/** Continues the caller's trace when its request carried one. */
const spanOptionsFor = (request: Request | undefined) =>
  whenPresent(
    "parent",
    request === undefined
      ? undefined
      : Option.getOrUndefined(HttpTraceContext.fromHeaders(Headers.fromInput(request.headers)))
  )

/** A client that closes the call's stream cancels it: the run is interrupted, and with it the upstream call. */
const resultOf = (
  runtime: McpRuntime,
  call: { readonly tool: string; readonly caller: McpCaller; readonly context: ServerContext },
  effect: Effect.Effect<ToolOutput, GatewayError, GatewayOperationServices>
): Promise<ToolReply> =>
  runtime.runPromise(
    effect.pipe(
      Effect.tap((output) =>
        Effect.annotateCurrentSpan(
          "mcp.tool.outcome",
          output.kind === "result" ? (output.failed ? "failed" : "result") : output.kind
        )
      ),
      Effect.tapError((failure) =>
        Effect.logInfo("MCP tool call refused", failure).pipe(Effect.annotateLogs({ "error.tag": failure._tag }))
      ),
      Effect.matchCauseEffect({
        onSuccess: (output) =>
          replyOf(output, call.caller).pipe(Effect.catch((failure) => Effect.succeed(errorResultOf(failure)))),
        onFailure: (cause) =>
          Option.match(Cause.findErrorOption(cause), {
            onSome: (failure) => Effect.succeed(errorResultOf(failure)),
            onNone: () => Effect.map(traceIdFor(cause), (traceId) => errorResultOf(new GatewayFailure({ traceId })))
          })
      }),
      Effect.withSpan("Mcp.callTool", {
        kind: "server",
        attributes: { "mcp.tool": call.tool, "profile.id": call.caller.profile.id },
        ...spanOptionsFor(call.context.http?.req)
      })
    ),
    { signal: call.context.mcpReq.signal }
  )

/** A request other than a tool call, failed the way MCP reports it: the gateway's own words, as a JSON-RPC error. */
const protocolRun =
  (runtime: McpRuntime): ResourceRun =>
  (effect, context) =>
    runtime
      .runPromiseExit(effect.pipe(Effect.withSpan("Mcp.request", spanOptionsFor(context.http?.req))), {
        signal: context.mcpReq.signal
      })
      .then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        if (error?._tag === "NotFound") throw new ResourceNotFoundError(error.id, describeError(error))
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          error === undefined ? "The gateway failed to read the resource" : describeError(error)
        )
      })

export interface McpGatewayOptions {
  readonly store: GatewayStore
  readonly services: Context.Context<GatewayStoreService | IntegrationServices | OAuthFlowSessions | GatewayEvents>
  readonly settings: GatewaySettings
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
  readonly telemetry: Layer.Layer<never>
  readonly errorCapture?: ErrorSink
  readonly oauth?: {
    readonly authenticate: (token: string) => Promise<
      | {
          readonly profile: Profile
          readonly actor: OAuthActor
          readonly expiresAt: Date
          readonly scope: "mcp"
        }
      | undefined
    >
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

const subjectOf = (principal: McpPrincipal): SubjectId | undefined =>
  principal.credential.kind === "key"
    ? (principal.credential.key.subjectId ?? undefined)
    : principal.credential.actor.subjectId

const callerFor = (principal: McpPrincipal, context: ServerContext): McpCaller => {
  const agent = agentOf(context)
  return {
    profile: principal.profile,
    subject: subjectOf(principal),
    origin:
      principal.credential.kind === "key"
        ? keyOrigin(principal.credential.key, agent)
        : oauthOrigin(principal.credential.actor, agent),
    approvalPrompt: approvalPromptOf(context),
    interaction: interactionOf(context),
    elicitation: elicitationOf(context),
    answered: new Set(Object.keys(context.mcpReq.inputResponses ?? {})),
    requestState: Option.getOrUndefined(decodeRequestState(context.mcpReq.requestState())),
    tasks: declaresExtension(context, tasksExtension)
  }
}

const registerAgentTool = (server: McpServer, runtime: McpRuntime, principal: McpPrincipal, tool: AgentTool): void => {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: checkedByGateway(tool.inputSchema)
    },
    async (arguments_, context) => {
      const caller = callerFor(principal, context)
      return resultOf(runtime, { tool: tool.name, caller, context }, tool.run(caller, asJson(arguments_)))
    }
  )
}

/** What the tool's source said about it, passed on to the agent in MCP's own terms. */
const hintsOf = (tool: EffectiveTool): ToolAnnotations => ({
  ...whenPresent("readOnlyHint", tool.readOnly),
  ...whenPresent("destructiveHint", tool.destructive),
  ...whenPresent("idempotentHint", tool.idempotent),
  ...whenPresent("openWorldHint", tool.openWorld)
})

/** The profile's tools, with schemas when they are served as tools of their own, and what the catalog says of each integration. */
const surfaceOf = (profile: Profile, subject: SubjectId | undefined) =>
  Effect.gen(function* () {
    const store = yield* GatewayStoreService
    const integrations = yield* Integrations
    const [listed, described] = yield* Effect.all(
      [
        capture(listEffectiveTools(store, profile.id, { schemas: profile.mcpSurface === "tools", integrations })),
        capture(integrations.listIntegrations())
      ],
      { concurrency: 2 }
    )
    const effective = listed.filter(reachableBy(subject))
    return { effective, instructions: instructionsFor(profile, effective, described) }
  })

const DeclaredApps = Schema.Struct({
  params: Schema.Struct({
    _meta: Schema.Struct({
      [CLIENT_CAPABILITIES_META_KEY]: Schema.Struct({
        extensions: Schema.Struct({
          [mcpAppsExtension]: Schema.Struct({ mimeTypes: Schema.Array(Schema.String) })
        })
      })
    })
  })
})
const decodeDeclaredApps = Schema.decodeUnknownOption(Schema.fromJsonString(DeclaredApps))

/**
 * Whether the request comes from a host that renders MCP Apps. It is read
 * from the body before the SDK builds the request's server, since which tools
 * the server lists depends on it.
 */
const rendersApps = async (request: Request): Promise<boolean> => {
  if (request.method !== "POST") return false
  const body = await request
    .clone()
    .text()
    .catch(() => "")
  return Option.exists(decodeDeclaredApps(body), (declared) =>
    declared.params._meta[CLIENT_CAPABILITIES_META_KEY].extensions[mcpAppsExtension].mimeTypes.includes(mcpAppMimeType)
  )
}

/**
 * A tool's metadata as this client should see it: a host that renders Apps
 * gets its view under the gateway's URI; any other host gets no view at all.
 */
const metaFor = (tool: EffectiveTool, apps: boolean): Record<string, Json> | undefined => {
  if (tool.ui === undefined || tool.meta === undefined) return tool.meta
  const rest = Object.fromEntries(Object.entries(tool.meta).filter(([key]) => key !== "ui" && key !== "ui/resourceUri"))
  if (!apps) return Object.keys(rest).length === 0 ? undefined : rest
  const declared = tool.meta["ui"]
  const view =
    declared !== undefined && isJsonObject(declared)
      ? { ...declared, resourceUri: tool.ui.resourceUri }
      : { resourceUri: tool.ui.resourceUri }
  return tool.meta["ui/resourceUri"] === undefined
    ? { ...rest, ui: view }
    : { ...rest, ui: view, "ui/resourceUri": tool.ui.resourceUri }
}

/** A tool only its own view may call stays out of the list a host without Apps hands its model. */
const listedFor = (tool: EffectiveTool, apps: boolean): boolean =>
  apps || tool.ui?.visibility === undefined || tool.ui.visibility.includes("model")

const serverFor = async (
  runtime: McpRuntime,
  request: Request | undefined,
  principal: McpPrincipal,
  apps: boolean
): Promise<McpServer> => {
  const profile = principal.profile
  const { effective, instructions } = await runtime.runPromise(
    surfaceOf(profile, subjectOf(principal)).pipe(
      Effect.withSpan("Mcp.listTools", { attributes: { "profile.id": profile.id }, ...spanOptionsFor(request) })
    )
  )
  const server = new McpServer(
    { name: "integrations-gateway", version: gatewayVersion },
    { instructions, capabilities: { tools: { listChanged: true }, extensions: { [tasksExtension]: {} } } }
  )
  const connections = connectionsOf(effective)
  serveResources(server, protocolRun(runtime), connections)
  serveSkills(server, protocolRun(runtime), connections)
  serveTasks(server, protocolRun(runtime), (context) => callerFor(principal, context))

  if (profile.mcpSurface === "discovery") {
    for (const tool of agentTools) {
      if (tool.capability === undefined || profile.capabilities.includes(tool.capability)) {
        registerAgentTool(server, runtime, principal, tool)
      }
    }
    return server
  }

  for (const tool of effective.filter((candidate) => listedFor(candidate, apps))) {
    const name = ToolName.make(tool.tool)
    const inputSchema =
      tool.inputSchema !== undefined && isJsonObject(tool.inputSchema)
        ? objectEntries(tool.inputSchema)
        : defaultInputSchema
    server.registerTool(
      toolName(tool.alias, name),
      {
        title: `${tool.title ?? tool.tool} (${tool.connection.integration} / ${tool.connection.name})`,
        ...whenPresent("description", describeEffectiveTool(tool)),
        annotations: hintsOf(tool),
        inputSchema: checkedByGateway(inputSchema),
        ...whenPresent("outputSchema", outputSchemaOf(tool.outputSchema)),
        ...whenPresent(
          "icons",
          tool.icons?.map(({ sizes, ...icon }) => ({
            ...icon,
            ...whenPresent("sizes", sizes === undefined ? undefined : [...sizes])
          }))
        ),
        ...whenPresent("_meta", metaFor(tool, apps))
      },
      async (arguments_, context) => {
        const caller = callerFor(principal, context)
        return resultOf(
          runtime,
          { tool: toolName(tool.alias, name), caller, context },
          invokeTool(caller, {
            alias: tool.alias,
            tool: name,
            arguments: asJson(arguments_)
          })
        )
      }
    )
  }
  return server
}

export interface McpGatewayHandle {
  handle(request: Request): Promise<Response>
  dispose(): Promise<void>
}

/** A tenant's profiles decide which tools and resources its clients see; the catalog's tools are everyone's. */
const announceChanges = (tenantId: TenantId, handler: McpHttpHandler) =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* GatewayEvents
      const changes = yield* events.subscribe(tenantId)
      yield* Stream.runForEach(changes, (change) =>
        Effect.sync(() => {
          if (change.resource !== "profiles" && change.resource !== "integrations") return
          handler.notify.toolsChanged()
          handler.notify.resourcesChanged()
        })
      )
    })
  )

export const createMcpGatewayHandler = (options: McpGatewayOptions): McpGatewayHandle => {
  const runtime: McpRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeedContext(options.services),
      Layer.succeed(GatewayConfig, options.settings),
      options.errorCapture === undefined ? ErrorCapture.logging : Layer.succeed(ErrorCapture, options.errorCapture),
      options.httpClient,
      webCryptoLayer,
      options.telemetry
    )
  )
  const authenticate = (secret: string, request: Request | undefined) =>
    runtime.runPromise(
      capture(authenticateKey(options.store, secret)).pipe(Effect.withSpan("Mcp.authenticate", spanOptionsFor(request)))
    )
  const resolve = async (secret: string, request: Request | undefined) => {
    if (secret.startsWith("igoa_") && options.oauth !== undefined) {
      const oauth = await options.oauth.authenticate(secret)
      return oauth === undefined
        ? undefined
        : {
            principal: {
              profile: oauth.profile,
              credential: { kind: "oauth", actor: oauth.actor }
            } satisfies McpPrincipal,
            scope: oauth.scope
          }
    }
    const apiKey = await authenticate(secret, request)
    return apiKey.status === "authenticated"
      ? {
          principal: { profile: apiKey.profile, credential: { kind: "key", key: apiKey.key } } satisfies McpPrincipal,
          scope: apiKey.profile.capabilities.join(" ")
        }
      : apiKey
  }
  const factory = async ({ authInfo, requestInfo }: McpRequestContext) => {
    if (authInfo === undefined) throw new Error("Authenticated MCP request has no identity")
    const authentication = await resolve(authInfo.token, requestInfo)
    if (authentication === undefined || "status" in authentication) throw new Error("MCP credential is no longer valid")
    return serverFor(
      runtime,
      requestInfo,
      authentication.principal,
      requestInfo === undefined ? false : (appsHosts.get(requestInfo) ?? false)
    )
  }
  const appsHosts = new WeakMap<Request, boolean>()
  /**
   * One handler per tenant, so the clients listening for changes hear only
   * about their own tenant's profiles, and about the catalog all tenants share.
   */
  const handlers = new Map<TenantId, McpHttpHandler>()
  const listeners: Array<Fiber.Fiber<void>> = []
  const handlerFor = (tenantId: TenantId): McpHttpHandler => {
    const existing = handlers.get(tenantId)
    if (existing !== undefined) return existing
    const created = createMcpHandler(factory)
    handlers.set(tenantId, created)
    listeners.push(runtime.runFork(announceChanges(tenantId, created)))
    return created
  }

  return {
    handle: async (request) => {
      const secret = presentedSecret(request)
      if (secret === undefined || secret.length === 0) {
        return errorResponse(new Unauthorized({ code: "missing-credential" }), options.oauth?.challenge() ?? "Bearer")
      }
      const authentication = await resolve(secret, request)
      if (authentication === undefined) {
        return errorResponse(
          new Unauthorized({ code: "invalid-token" }),
          options.oauth?.challenge("invalid_token") ?? "Bearer"
        )
      }
      if ("status" in authentication) {
        return errorResponse(refusedKey(authentication.status), "Bearer")
      }
      appsHosts.set(request, await rendersApps(request))
      return handlerFor(authentication.principal.profile.tenantId).fetch(request, {
        authInfo: {
          token: secret,
          clientId: authentication.principal.profile.id,
          scopes: authentication.scope.split(" ").filter((scope) => scope.length > 0)
        }
      })
    },
    dispose: async () => {
      await Effect.runPromise(Fiber.interruptAll(listeners))
      await Promise.all([...handlers.values()].map((handler) => handler.close()))
      await runtime.dispose()
    }
  }
}
