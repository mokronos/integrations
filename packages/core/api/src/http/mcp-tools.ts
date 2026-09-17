import { Data, Effect, Schema } from "effect"
import type { GatewayClient } from "@mokronos/integrations-client"
import {
  Alias,
  ApprovalId,
  asJson,
  blobHandleKey,
  ConnectionName,
  IntegrationSearchKind,
  IntegrationSlug,
  InvocationOutcome,
  isJsonObject,
  localFileKey,
  objectEntries,
  PositiveInt,
  ToolName,
  whenPresent
} from "@integrations/contracts"
import type { ClientCapability, Json, JsonEncodable } from "@integrations/contracts"

/** A refusal the gateway never saw: the arguments did not survive this surface. */
export class ToolRefusal extends Data.TaggedError("ToolRefusal")<{
  readonly message: string
}> {}

const refuse = (message: string): ToolRefusal => new ToolRefusal({ message })

export interface ToolOutput {
  readonly value: JsonEncodable
  readonly failed: boolean
}

const ok = (value: JsonEncodable): ToolOutput => ({ value, failed: false })

export interface AgentTool {
  readonly name: string
  readonly title: string
  readonly description: string
  /** Omitted when any client key may call it. */
  readonly capability?: ClientCapability
  readonly inputSchema: Record<string, Json>
  readonly run: (client: GatewayClient, input: Json) => Effect.Effect<ToolOutput, Error>
}

const jsonSchemaOf = (schema: Schema.Top): Record<string, Json> =>
  objectEntries(asJson(
    Schema.toJsonSchemaDocument(schema, { additionalProperties: false }).schema
  ))

const agentTool = <S extends Schema.Top & { readonly DecodingServices: never }>(definition: {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly capability?: ClientCapability
  readonly input: S
  readonly run: (client: GatewayClient, input: S["Type"]) => Effect.Effect<ToolOutput, Error>
}): AgentTool => {
  const decode = Schema.decodeUnknownEffect(definition.input)
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    ...whenPresent("capability", definition.capability),
    inputSchema: jsonSchemaOf(definition.input),
    run: (client, input) =>
      decode(input).pipe(
        Effect.mapError((cause) => refuse(`${definition.name}: ${cause.message}`)),
        Effect.flatMap((decoded) => definition.run(client, decoded))
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

/** Printed as it travelled: the decoded outcome carries a Date, JSON does not. */
const encodeOutcome = Schema.encodeSync(InvocationOutcome)

const blobsUnsupported =
  `This result references gateway blobs (${blobHandleKey}). Downloading them over MCP is not ` +
  `implemented yet; read them from GET /v1/blobs/<id> with this key, or run the same tool through the i CLI.`

const filesUnsupported =
  `Local file arguments (${localFileKey}) are uploaded by the i CLI before the gateway sees them. ` +
  `Sending files over MCP is not implemented yet; upload the bytes to POST /v1/blobs with this key ` +
  `and pass the ${blobHandleKey} handle it returns.`

/**
 * The one path every invocation takes, whether the agent called the tool by its
 * own name or reached it through `execute`.
 */
export const invokeTool = (
  client: GatewayClient,
  input: {
    readonly alias: Alias
    readonly tool: ToolName
    readonly arguments: Json
  }
): Effect.Effect<ToolOutput, Error> =>
  mentionsKey(input.arguments, localFileKey)
    ? Effect.fail(refuse(filesUnsupported))
    : Effect.map(
      client.delegated.execute({
        payload: { alias: input.alias, tool: input.tool, arguments: input.arguments }
      }),
      (outcome) => {
        const encoded = encodeOutcome(outcome)
        return {
          value: outcome.status === "succeeded" && mentionsKey(outcome.result, blobHandleKey)
            ? { ...objectEntries(asJson(encoded)), note: blobsUnsupported }
            : encoded,
          failed: outcome.status === "denied" || outcome.status === "failed" || outcome.status === "invalid"
        }
      }
    )

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
  run: (client, input) =>
    Effect.map(
      client.provisioning.discover({
        payload: {
          url: input.url,
          ...whenPresent("connection", input.connection),
          ...whenPresent("slug", input.slug),
          ...whenPresent("name", input.name)
        }
      }),
      (discovery) =>
        ok(input.verbose === true
          ? discovery
          : {
            integration: discovery.integration,
            requiresAuthentication: discovery.requiresAuthentication,
            authMethods: discovery.authMethods,
            toolCount: discovery.tools.length
          })
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
  run: (client, input) =>
    Effect.map(
      client.provisioning.registrySearch({
        query: {
          q: input.query,
          limit: PositiveInt.make(input.limit ?? 5),
          ...whenPresent("kind", input.kind)
        }
      }),
      ok
    )
})

const integrationsTool = agentTool({
  name: "integrations",
  title: "List registered integrations",
  description: "List every registered integration and how many of its connections are live.",
  capability: "provision_connections",
  input: Schema.Struct({ verbose: verboseField }),
  run: (client, input) =>
    Effect.map(client.provisioning.listIntegrations(), (result) =>
      ok({
        integrations: result.integrations.map((integration) =>
          input.verbose === true ? integration : {
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
      }))
})


const toolsTool = agentTool({
  name: "tools",
  title: "List the tools this key may call",
  description:
    "List the effective tools this key may call, with the approval decision each one carries. " +
    "Narrow with integration, connection, or filter; ask for verbose to include input schemas.",
  input: Schema.Struct({
    integration: Schema.optional(IntegrationSlug),
    connection: connectionField,
    filter: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
    offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    verbose: verboseField
  }),
  run: (client, input) =>
    Effect.map(
      client.delegated.listTools({
        query: {
          schemas: true,
          ...whenPresent("integration", input.integration),
          ...whenPresent("connection", input.connection)
        }
      }),
      (result) => {
        const term = input.filter?.toLowerCase()
        const matching = term === undefined
          ? result.tools
          : result.tools.filter((tool) =>
            tool.tool.toLowerCase().includes(term) ||
            (tool.description ?? "").toLowerCase().includes(term)
          )
        const offset = input.offset ?? 0
        const windowed = input.limit === undefined
          ? matching.slice(offset)
          : matching.slice(offset, offset + input.limit)
        return ok({
          tools: windowed.map((tool) =>
            input.verbose === true ? tool : {
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
    "Show one effective tool's description and input/output schemas. Address it the same way " +
    "`execute` does: by the connection alias `tools` reports, plus the tool name.",
  input: Schema.Struct({ alias: Alias, tool: ToolName }),
  run: (client, input) =>
    Effect.flatMap(
      client.delegated.listTools({ query: { schemas: true } }),
      (result) => {
        const found = result.tools.find((candidate) =>
          candidate.alias === input.alias && candidate.tool === input.tool
        )
        return found === undefined
          ? Effect.fail(refuse(`${input.tool} is not available to this key through ${input.alias}`))
          : Effect.succeed(ok(found))
      }
    )
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
  run: (client, input) =>
    Effect.gen(function*() {
      const catalog = yield* client.provisioning.listIntegrations()
      const integration = catalog.integrations.find((candidate) =>
        candidate.slug === input.integration
      )
      if (integration === undefined) {
        return yield* refuse(`Unknown integration ${input.integration}. Run discover first.`)
      }
      const oauthMethod = integration.authMethods.find((method) =>
        method.kind === "oauth" &&
        (input.template === undefined || method.template === input.template)
      )
      const credentialsOffered = Object.keys(input.values ?? {}).length > 0
      if (oauthMethod !== undefined && credentialsOffered && input.template === undefined) {
        const alternatives = integration.authMethods.filter((method) => method.kind !== "oauth")
        return yield* refuse(alternatives.length === 0
          ? `${input.integration} only supports OAuth, so values cannot be used. Drop them and let a human authorize in a browser.`
          : `${input.integration} supports OAuth and ${
            alternatives.map((method) => method.template).join(", ")
          }. Name the one you mean with template.`)
      }

      if (oauthMethod !== undefined) {
        const session = yield* client.provisioning.startOAuth({
          payload: {
            integration: input.integration,
            ...whenPresent("connection", input.connection),
            ...whenPresent("template", input.template),
            ...whenPresent("clientId", input.clientId),
            ...whenPresent("clientSecret", input.clientSecret),
            ...whenPresent("timeoutSeconds", input.timeoutSeconds)
          }
        })
        return ok({
          ...session,
          next: `A human has to finish this in a browser. Poll oauth_status with sessionId ${session.id}.`
        })
      }

      const connected = yield* client.provisioning.connect({
        payload: {
          integration: input.integration,
          ...whenPresent("connection", input.connection),
          ...whenPresent("template", input.template),
          values: input.values ?? {}
        }
      })
      return ok(input.verbose === true ? connected : {
        connection: connected.connection,
        toolCount: connected.tools.length
      })
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
  run: (client, input) =>
    Effect.map(
      client.provisioning.oauthSession({ params: { id: input.sessionId } }),
      ok
    )
})

const connectionsTool = agentTool({
  name: "connections",
  title: "List connections",
  description: "List every connection this gateway holds, and whether each one still works.",
  capability: "provision_connections",
  input: Schema.Struct({}),
  run: (client) => Effect.map(client.provisioning.listConnections(), ok)
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
  run: (client, input) =>
    Effect.map(
      client.provisioning.removeConnection({
        params: { integration: input.integration, name: input.connection ?? "default" }
      }),
      ok
    )
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
  run: (client, input) =>
    invokeTool(client, {
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
  run: (client, input) => {
    if ((input.address === undefined) === (input.node === undefined)) {
      return Effect.fail(refuse("Provide exactly one of address or node"))
    }
    const node: Json = input.address === undefined
      ? input.node ?? null
      : { source: { kind: "tool", address: input.address } }
    return Effect.map(
      client.provisioning.validate({
        payload: { node, live: input.structural !== true }
      }),
      ok
    )
  }
})

const approvalTool = agentTool({
  name: "approval",
  title: "Read a frozen invocation",
  description:
    "Read one invocation that is waiting on a human, as the key that proposed it. An execute that " +
    "came back pending is collected here once somebody approves it.",
  input: Schema.Struct({ approvalId: ApprovalId }),
  run: (client, input) =>
    Effect.map(
      client.delegated.approval({ params: { id: input.approvalId } }),
      ok
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
