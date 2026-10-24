import { Effect, Option, Schema } from "effect"
import {
  Alias,
  ApprovalId,
  asJson,
  blobHandleKey,
  ConnectionName,
  IntegrationSearchKind,
  InvalidInput,
  NotFound,
  NotImplemented,
  OAuthSessionView,
  IntegrationSlug,
  InvocationOutcome,
  isJsonObject,
  localFileKey,
  objectEntries,
  PositiveInt,
  ToolName,
  whenPresent
} from "@integragents/contracts"
import type {
  GatewayError,
  InputRequests,
  Json,
  JsonEncodable,
  Profile,
  ProfileCapability,
  SubjectId,
  ToolDecision
} from "@integragents/contracts"
import { Integrations, listIntegrationOverviews, searchIntegrations } from "@integragents/integrations"
import {
  decideWaitingApproval,
  GatewayStoreService,
  invokeAsProfile,
  listEffectiveTools,
  reachableBy
} from "@integragents/gateway-core"
import type { CallOrigin, Interaction } from "@integragents/gateway-core"
import { capture } from "./observability.ts"
import {
  asCallerFailure,
  connectWithCredentials,
  discoverIntegration,
  findProfileApproval,
  invokeDependencies,
  removeConnectionByName,
  startOAuthConnection,
  validateReference
} from "./operations.ts"
import type { GatewayOperationServices } from "./operations.ts"
import { GatewayConfig } from "./services.ts"
import { OAuthFlowSessions } from "@integragents/gateway-core"

/** A tool call's outcome as the gateway tells it: never `invalid` or `input-required`, which leave by other paths. */
export type CallOutcome = Exclude<InvocationOutcome, { readonly status: "invalid" | "input-required" }>

export type ToolOutput =
  | { readonly kind: "result"; readonly value: JsonEncodable; readonly failed: boolean }
  | { readonly kind: "outcome"; readonly alias: Alias; readonly outcome: CallOutcome }
  /** The call waits for a human, told as a task the client polls. */
  | { readonly kind: "task"; readonly approvalId: ApprovalId }
  | { readonly kind: "ask-approval"; readonly message: string }
  /** A link only a human may open, put to them by the client instead of handed to the model. */
  | {
      readonly kind: "ask-url"
      readonly key: string
      readonly message: string
      readonly url: string
      readonly requestState?: string
    }
  | { readonly kind: "input-required"; readonly inputRequests: InputRequests; readonly requestState: string }

const ok = (value: JsonEncodable): ToolOutput => ({ kind: "result", value, failed: false })

/**
 * Whether the human can answer an approval inside the MCP client, and what
 * they answered. `remember` saves an approval for these exact arguments; an
 * answer carrying anything the form did not ask for is `malformed`.
 */
export type ApprovalPrompt =
  | { readonly kind: "unsupported" }
  | { readonly kind: "unanswered" }
  | { readonly kind: "malformed" }
  | { readonly kind: "answered"; readonly action: "accept" | "decline" | "cancel"; readonly remember: boolean }

/** The approval form: one optional choice, and nothing else a client may send back. */
export const approvalForm = {
  type: "object",
  properties: {
    remember: {
      type: "boolean",
      title: "Always approve these exact arguments",
      description: "Save an approval so later calls to this tool with the same arguments run without asking.",
      default: false
    }
  }
} as const

const ApprovalAnswer = Schema.Struct({ remember: Schema.optional(Schema.Boolean) })
export const decodeApprovalAnswer = Schema.decodeUnknownOption(ApprovalAnswer, { onExcessProperty: "error" })

/** Namespaced, so other input requests can ride along in the same round. */
export const approvalInputKey = "integrations/approval"
export const authorizeInputKey = "integrations/authorize"

/** The profile an MCP call speaks for, and the credential and app it came through. */
export interface McpCaller {
  readonly profile: Profile
  readonly origin: CallOrigin
  /** The person the credential acts for; delegated tools reach only their connections. */
  readonly subject: SubjectId | undefined
  readonly approvalPrompt: ApprovalPrompt
  readonly interaction: Interaction
  /** Which kinds of elicitation the client said it can put to its human. */
  readonly elicitation: { readonly form: boolean; readonly url: boolean }
  /** The input keys a retried request carries answers for. */
  readonly answered: ReadonlySet<string>
  /** The state a retried request carries, as the gateway handed it out. */
  readonly requestState: string | undefined
  /** The client declared the Tasks extension, so a call held for a human can answer as a task. */
  readonly tasks: boolean
}

export const sessionLink = (state: OAuthSessionView["state"]): string | undefined =>
  state.status === "pending" ? state.authorizationUrl : state.status === "needs-client" ? state.setupUrl : undefined

/**
 * An authorization link goes to the client's human as a URL elicitation when
 * the client can show one, once per call: an answered prompt that still finds
 * the flow unfinished gets the outcome, not the same prompt again.
 */
const askToAuthorize = (caller: McpCaller, outcome: InvocationOutcome): ToolOutput | undefined => {
  if (outcome.status !== "authorization-required" || !caller.elicitation.url) return undefined
  if (caller.answered.has(authorizeInputKey)) return undefined
  const url = sessionLink(outcome.session.state)
  if (url === undefined) return undefined
  return {
    kind: "ask-url",
    key: authorizeInputKey,
    message:
      outcome.scopes === undefined
        ? `Authorize ${outcome.integration} so the agent can use it on your behalf.`
        : `${outcome.integration} needs more access for this call: ${outcome.scopes.join(", ")}. Authorize it to continue.`,
    url
  }
}

export type ToolRun = Effect.Effect<ToolOutput, GatewayError, GatewayOperationServices>

export interface AgentTool {
  readonly name: string
  readonly title: string
  readonly description: string
  /** Omitted when any profile may call it. */
  readonly capability?: ProfileCapability
  readonly inputSchema: Record<string, Json>
  readonly run: (caller: McpCaller, input: Json) => ToolRun
}

const jsonSchemaOf = (schema: Schema.Top): Record<string, Json> =>
  objectEntries(asJson(Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }).schema))

const agentTool = <S extends Schema.Top & { readonly DecodingServices: never }>(definition: {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly capability?: ProfileCapability
  readonly input: S
  readonly run: (caller: McpCaller, input: S["Type"]) => ToolRun
}): AgentTool => {
  const decode = Schema.decodeUnknownEffect(definition.input)
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    ...whenPresent("capability", definition.capability),
    inputSchema: jsonSchemaOf(definition.input),
    run: (caller, input) =>
      decode(input).pipe(
        Effect.mapError((failure) => InvalidInput.fromSchemaError("arguments", failure)),
        Effect.flatMap((decoded) => definition.run(caller, decoded))
      )
  }
}

const verboseField = Schema.optional(Schema.Boolean)
const connectionField = Schema.optional(ConnectionName)

const inline = (value: string, limit: number): string => {
  const collapsed = value.replace(/\s+/g, " ").trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`
}

const mentionsKey = (value: Json, key: string): boolean =>
  Array.isArray(value)
    ? value.some((item) => mentionsKey(item, key))
    : isJsonObject(value)
      ? key in value || Object.values(value).some((nested) => mentionsKey(nested, key))
      : false

const encodeSession = Schema.encodeSync(OAuthSessionView)

const filesUnsupported = new NotImplemented({
  feature: `Local file arguments (${localFileKey}) over MCP`,
  alternative: `Upload the bytes to POST /v1/blobs with this key and pass the ${blobHandleKey} handle it returns, or call the tool through the i CLI`
})

export const approvalMessage = (input: {
  readonly alias: Alias
  readonly tool: ToolName
  readonly arguments: Json
}): string => `Approve ${input.alias}.${input.tool}?\n\n${inline(JSON.stringify(input.arguments), 2_000)}`

const malformedAnswer = new InvalidInput({
  field: "approval answer",
  problem:
    "it carried fields the approval form does not ask for, so nothing was decided; the call still waits for a human"
})

const awaitsApproval =
  "Calls to this tool are held until a human approves them, unless a saved approval covers their arguments."

/** What an agent is told about a tool's approval gate; nothing for a tool that runs directly. */
export const approvalDescription = (decision: ToolDecision): string | undefined =>
  decision === "require_approval" ? awaitsApproval : undefined

/**
 * Records the human's in-client answer the way the dashboard records one, so
 * remembering saves the same approval. The approved call's outcome comes back
 * when it ran into an input round; a call decided elsewhere in the meantime
 * keeps that decision.
 */
export const decideInClient = (
  caller: McpCaller,
  answer: {
    readonly approvalId: ApprovalId
    readonly accepted: boolean
    readonly remember: boolean
    /** How the decision reached the gateway, recorded with who made it. */
    readonly how?: string
  }
): Effect.Effect<InvocationOutcome | undefined, never, GatewayOperationServices> =>
  Effect.gen(function* () {
    const dependencies = yield* invokeDependencies
    const config = yield* GatewayConfig
    return yield* capture(
      decideWaitingApproval(
        { store: dependencies.store, integrations: dependencies.integrations, retentionDays: config.retentionDays },
        {
          tenantId: caller.profile.tenantId,
          id: answer.approvalId,
          verdict: answer.accepted ? "approve" : "deny",
          decidedBy: `${caller.origin.caller.credentialName ?? caller.profile.name} (${answer.how ?? "in-client approval"})`,
          remember: answer.remember,
          relay: caller.interaction.relay
        }
      )
    ).pipe(
      Effect.catchTags({
        NotFound: () => Effect.succeed(undefined),
        ApprovalConflict: () => Effect.succeed(undefined),
        InvalidInput: () => Effect.succeed(undefined)
      })
    )
  })

/**
 * The one path every invocation takes, whether the agent called the tool by its
 * own name or reached it through `execute`.
 */
export const invokeTool = (
  caller: McpCaller,
  input: {
    readonly alias: Alias
    readonly tool: ToolName
    readonly arguments: Json
  }
): ToolRun =>
  Effect.gen(function* () {
    if (mentionsKey(input.arguments, localFileKey)) return yield* filesUnsupported
    const dependencies = yield* invokeDependencies
    const invoke = capture(
      invokeAsProfile(dependencies, {
        profile: caller.profile,
        origin: caller.origin,
        alias: input.alias,
        tool: input.tool,
        arguments: input.arguments,
        interaction: caller.interaction,
        ...whenPresent("subject", caller.subject)
      })
    )
    const first = yield* invoke
    if (first.status === "pending" && caller.tasks) return { kind: "task", approvalId: first.approvalId }
    const prompt = caller.approvalPrompt
    const inClient =
      first.status === "pending" && caller.profile.approvalMethod === "elicitation" && prompt.kind !== "unsupported"
    if (
      first.status === "pending" &&
      !inClient &&
      first.approvalUrl !== undefined &&
      caller.elicitation.url &&
      !caller.answered.has(approvalInputKey)
    ) {
      return {
        kind: "ask-url",
        key: approvalInputKey,
        message: `${approvalMessage(input)}\n\nOpen the link to approve or deny this call.`,
        url: first.approvalUrl
      }
    }
    if (inClient && prompt.kind === "unanswered") return { kind: "ask-approval", message: approvalMessage(input) }
    if (inClient && prompt.kind === "malformed") return yield* malformedAnswer
    const answered =
      inClient && prompt.kind === "answered" && prompt.action !== "cancel"
        ? { approvalId: first.approvalId, accepted: prompt.action === "accept", remember: prompt.remember }
        : undefined
    const decided = answered === undefined ? undefined : yield* decideInClient(caller, answered)
    const outcome = decided?.status === "input-required" ? decided : answered === undefined ? first : yield* invoke
    if (outcome.status === "input-required") {
      return { kind: "input-required", inputRequests: outcome.inputRequests, requestState: outcome.requestState }
    }
    if (outcome.status === "invalid") return yield* outcome.error
    if (outcome.status === "failed" && outcome.error !== undefined) return yield* outcome.error
    return askToAuthorize(caller, outcome) ?? { kind: "outcome", alias: input.alias, outcome }
  })

const discoverTool = agentTool({
  name: "discover",
  title: "Discover an integration",
  description:
    "Detect and register an integration from an MCP endpoint or OpenAPI document URL. " +
    "Registering does not authorize it; follow with connect.",
  capability: "provision_connections",
  input: Schema.Struct({
    url: Schema.String,
    connection: Schema.optional(Schema.String),
    slug: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    verbose: verboseField
  }),
  run: (caller, input) =>
    Effect.map(
      asCallerFailure(
        discoverIntegration(caller.profile.tenantId, input.url, {
          ...whenPresent("connection", input.connection),
          ...whenPresent("slug", input.slug),
          ...whenPresent("name", input.name)
        })
      ),
      (discovery) =>
        ok(
          input.verbose === true
            ? discovery
            : {
                integration: discovery.integration,
                requiresAuthentication: discovery.requiresAuthentication,
                authMethods: discovery.authMethods,
                toolCount: discovery.tools.length
              }
        )
    )
})

const searchTool = agentTool({
  name: "search",
  title: "Search the integration registry",
  description:
    "Search integrations.sh for exact integration URLs by service name, domain, or keyword. " +
    "Feed a result's URL to discover.",
  capability: "provision_connections",
  input: Schema.Struct({
    query: Schema.String,
    kind: Schema.optional(IntegrationSearchKind),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })))
  }),
  run: (_, input) =>
    Effect.gen(function* () {
      const config = yield* GatewayConfig
      return ok(
        yield* searchIntegrations(
          {
            q: input.query,
            limit: PositiveInt.make(input.limit ?? 5),
            ...whenPresent("kind", input.kind)
          },
          whenPresent("registryUrl", config.registryUrl)
        )
      )
    })
})

const integrationsTool = agentTool({
  name: "integrations",
  title: "List registered integrations",
  description: "List every registered integration and how many of its connections are live.",
  capability: "provision_connections",
  input: Schema.Struct({ verbose: verboseField }),
  run: (_, input) =>
    Effect.map(capture(listIntegrationOverviews()), (integrations) =>
      ok({
        integrations: integrations.map((integration) =>
          input.verbose === true
            ? integration
            : {
                slug: integration.slug,
                name: integration.name,
                kind: integration.kind,
                description: inline(integration.description, 200),
                authMethods: integration.authMethods.map((method) => method.template),
                connections: integration.connections.map((connection) => ({
                  name: connection.name,
                  status: connection.status
                })),
                toolCount: integration.tools.length
              }
        )
      })
    )
})

const effectiveTools = (
  caller: McpCaller,
  filter: { readonly integration?: IntegrationSlug; readonly connection?: ConnectionName }
) =>
  Effect.gen(function* () {
    const store = yield* GatewayStoreService
    const integrations = yield* Integrations
    const tools = yield* capture(
      listEffectiveTools(store, caller.profile.id, {
        schemas: true,
        integrations,
        ...whenPresent("integration", filter.integration),
        ...whenPresent("connection", filter.connection)
      })
    )
    return tools.filter(reachableBy(caller.subject))
  })

const toolsTool = agentTool({
  name: "tools",
  title: "List the tools this key may call",
  description:
    "List the tools this key may call, with the approval decision each one carries. " +
    "Narrow with integration, connection, or filter; ask for verbose to include input schemas.",
  input: Schema.Struct({
    integration: Schema.optional(IntegrationSlug),
    connection: connectionField,
    filter: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
    offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    verbose: verboseField
  }),
  run: (caller, input) =>
    Effect.map(
      effectiveTools(caller, {
        ...whenPresent("integration", input.integration),
        ...whenPresent("connection", input.connection)
      }),
      (tools) => {
        const term = input.filter?.toLowerCase()
        const matching =
          term === undefined
            ? tools
            : tools.filter(
                (tool) =>
                  tool.tool.toLowerCase().includes(term) || (tool.description ?? "").toLowerCase().includes(term)
              )
        const offset = input.offset ?? 0
        const windowed =
          input.limit === undefined ? matching.slice(offset) : matching.slice(offset, offset + input.limit)
        return ok({
          tools: windowed.map((tool) =>
            input.verbose === true
              ? tool
              : {
                  alias: tool.alias,
                  tool: tool.tool,
                  decision: tool.decision,
                  description: inline(tool.description ?? "", 200)
                }
          ),
          count: matching.length,
          offset
        })
      }
    )
})

const schemaTool = agentTool({
  name: "schema",
  title: "Show one tool's schemas",
  description:
    "Show one tool's description, input/output schemas, and whether its calls wait for a human's approval. " +
    "Address it the same way `execute` does: by the connection alias `tools` reports, plus the tool name.",
  input: Schema.Struct({ alias: Alias, tool: ToolName }),
  run: (caller, input) =>
    Effect.flatMap(effectiveTools(caller, {}), (tools) => {
      const found = tools.find((candidate) => candidate.alias === input.alias && candidate.tool === input.tool)
      return found === undefined
        ? Effect.fail(
            new NotFound({
              resource: "tool",
              id: `${input.alias}.${input.tool}`,
              known: tools.filter((candidate) => candidate.alias === input.alias).map((candidate) => candidate.tool)
            })
          )
        : Effect.succeed(ok({ ...found, ...whenPresent("approvalDescription", approvalDescription(found.decision)) }))
    })
})

const connectTool = agentTool({
  name: "connect",
  title: "Authorize an integration",
  description:
    "Authorize a registered integration. Integrations that use OAuth start a flow and return a " +
    "session to poll with oauth_status — the human authorizes in a browser. Everything else is " +
    "connected in one call from the credentials in values, which map auth field names to secrets.",
  capability: "provision_connections",
  input: Schema.Struct({
    integration: IntegrationSlug,
    connection: Schema.optional(Schema.String),
    template: Schema.optional(Schema.String),
    values: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    clientId: Schema.optional(Schema.String),
    clientSecret: Schema.optional(Schema.String),
    timeoutSeconds: Schema.optional(Schema.Number),
    verbose: verboseField
  }),
  run: (caller, input) =>
    Effect.gen(function* () {
      if (caller.requestState !== undefined && caller.answered.has(authorizeInputKey)) {
        const oauth = yield* OAuthFlowSessions
        const resumed = yield* capture(oauth.get(caller.requestState))
        if (resumed !== undefined) return ok(encodeSession(resumed))
      }
      const integrations = yield* Integrations
      const found = yield* capture(integrations.findIntegration(input.integration))
      if (Option.isNone(found)) return yield* new NotFound({ resource: "integration", id: input.integration })
      const integration = found.value
      const oauthMethod = integration.authMethods.find(
        (method) => method.kind === "oauth" && (input.template === undefined || method.template === input.template)
      )
      const credentialsOffered = Object.keys(input.values ?? {}).length > 0
      if (oauthMethod !== undefined && credentialsOffered && input.template === undefined) {
        const alternatives = integration.authMethods.filter((method) => method.kind !== "oauth")
        return yield* new InvalidInput({
          field: alternatives.length === 0 ? "values" : "template",
          problem:
            alternatives.length === 0
              ? `${input.integration} only supports OAuth, so values cannot be used; drop them and let a human authorize in a browser`
              : `${input.integration} supports OAuth and ${alternatives
                  .map((method) => method.template)
                  .join(", ")}; name the one you mean with template`
        })
      }

      const tenantId = caller.profile.tenantId
      if (oauthMethod !== undefined) {
        const session = yield* asCallerFailure(
          startOAuthConnection(tenantId, {
            integration: input.integration,
            ...whenPresent("connection", input.connection),
            ...whenPresent("template", input.template),
            ...whenPresent("clientId", input.clientId),
            ...whenPresent("clientSecret", input.clientSecret),
            ...whenPresent("timeoutSeconds", input.timeoutSeconds)
          }),
          input.integration
        )
        const link = sessionLink(session.state)
        if (link !== undefined && caller.elicitation.url) {
          return {
            kind: "ask-url",
            key: authorizeInputKey,
            message: `Authorize ${input.integration} for the agent in your browser.`,
            url: link,
            requestState: session.id
          }
        }
        return ok({
          ...encodeSession(session),
          next: `A human has to finish this in a browser. Poll oauth_status with sessionId ${session.id}.`
        })
      }

      const connected = yield* asCallerFailure(
        connectWithCredentials(tenantId, {
          integration: input.integration,
          ...whenPresent("connection", input.connection),
          ...whenPresent("template", input.template),
          values: input.values ?? {}
        }),
        input.integration
      )
      return ok(
        input.verbose === true
          ? connected
          : {
              connection: connected.connection,
              toolCount: connected.tools.length
            }
      )
    })
})

const oauthStatusTool = agentTool({
  name: "oauth_status",
  title: "Read an authorization in progress",
  description:
    "Read the state of an OAuth flow connect started. Poll until it reports connected or failed; " +
    "a needs-client state is waiting for a human to register an OAuth client at its setup URL.",
  capability: "provision_connections",
  input: Schema.Struct({ sessionId: Schema.String }),
  run: (_, input) =>
    Effect.gen(function* () {
      const oauth = yield* OAuthFlowSessions
      const session = yield* capture(oauth.get(input.sessionId))
      if (session === undefined) return yield* new NotFound({ resource: "oauth-session", id: input.sessionId })
      return ok(encodeSession(session))
    })
})

const connectionsTool = agentTool({
  name: "connections",
  title: "List connections",
  description: "List every connection this gateway holds, and whether each one still works.",
  capability: "provision_connections",
  input: Schema.Struct({}),
  run: () =>
    Effect.gen(function* () {
      const integrations = yield* Integrations
      return ok({ connections: yield* capture(integrations.listConnections()) })
    })
})

const disconnectTool = agentTool({
  name: "disconnect",
  title: "Delete a connection",
  description: "Delete a connection and forget the credential behind it.",
  capability: "provision_connections",
  input: Schema.Struct({
    integration: IntegrationSlug,
    connection: Schema.optional(Schema.String)
  }),
  run: (caller, input) =>
    Effect.map(removeConnectionByName(caller.profile.tenantId, input.integration, input.connection ?? "default"), ok)
})

const executeTool = agentTool({
  name: "execute",
  title: "Invoke a tool by alias",
  description:
    "Invoke any tool this key may call, by the connection alias `tools` reports and the tool name. " +
    "Inspect arguments with `schema` first.",
  input: Schema.Struct({
    alias: Alias,
    tool: ToolName,
    arguments: Schema.optional(Schema.Record(Schema.String, Schema.Json))
  }),
  run: (caller, input) =>
    invokeTool(caller, {
      alias: input.alias,
      tool: input.tool,
      arguments: input.arguments ?? {}
    })
})

const validateTool = agentTool({
  name: "validate",
  title: "Validate an integration reference",
  description:
    "Check that a tool address or node config still resolves. Pass address for a tool this key " +
    "reaches, or node for a whole config. Structural checks the shape only.",
  capability: "provision_connections",
  input: Schema.Struct({
    address: Schema.optional(Schema.String),
    node: Schema.optional(Schema.Json),
    structural: Schema.optional(Schema.Boolean)
  }),
  run: (caller, input) => {
    if ((input.address === undefined) === (input.node === undefined)) {
      return Effect.fail(new InvalidInput({ field: "address", problem: "pass exactly one of address or node" }))
    }
    const node: Json =
      input.address === undefined ? (input.node ?? null) : { source: { kind: "tool", address: input.address } }
    return Effect.map(validateReference(caller.profile.id, node, input.structural !== true), ok)
  }
})

const approvalTool = agentTool({
  name: "approval",
  title: "Read a frozen invocation",
  description:
    "Read one invocation that is waiting on a human, as the key that proposed it. An execute that " +
    "came back pending is collected here once somebody approves it.",
  input: Schema.Struct({ approvalId: ApprovalId }),
  run: (caller, input) =>
    Effect.flatMap(findProfileApproval(caller.profile, input.approvalId), (approval) =>
      approval === undefined
        ? Effect.fail(new NotFound({ resource: "approval", id: input.approvalId }))
        : Effect.succeed(ok(approval))
    )
})

/** The `i` CLI's surface, as tools. Ordered the way an agent meets them. */
export const agentTools: ReadonlyArray<AgentTool> = [
  searchTool,
  discoverTool,
  integrationsTool,
  connectTool,
  oauthStatusTool,
  connectionsTool,
  disconnectTool,
  toolsTool,
  schemaTool,
  executeTool,
  validateTool,
  approvalTool
]
