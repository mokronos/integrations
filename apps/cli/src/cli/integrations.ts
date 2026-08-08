import { Data, Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import {
  createExecutorConnection,
  describeExecutorTool,
  executeExecutorTool,
  ExecutorToolAddress,
  listExecutorConnections,
  listExecutorIntegrations,
  listExecutorToolSummaries,
  removeExecutorConnection,
  discoverIntegration,
  searchIntegrations,
  validateIntegrationNode
} from "@mokronos/wfkit-executor"
import type {
  ExecutorAuthMethod,
  ExecutorIntegration,
  ExecutorTool,
  ExecutorToolSummary,
  IntegrationSearchSurface
} from "@mokronos/wfkit-executor"
import { authorizeExecutorInBrowser, openBrowser } from "./oauth.ts"

class IntegrationCliError extends Data.TaggedError("IntegrationCliError")<{
  readonly message: string
}> {}

export interface IntegrationsCliOptions {
  readonly storageDir?: string
  readonly openBrowser?: (url: string) => void | Promise<void>
}

const cliError = (message: string): IntegrationCliError =>
  new IntegrationCliError({ message })

const errorMessage = (error: Error): string => error.message

const writeStdoutLine = (text: string): Effect.Effect<void, IntegrationCliError> =>
  Effect.tryPromise({
    try: () => new Promise<void>((resolve, reject) => {
      process.stdout.write(`${text}\n`, (error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    }),
    catch: (error) => cliError(`Could not write output: ${String(error)}`)
  })

const inlineLimit = 800

const inline = (value: string, limit = inlineLimit): string => {
  const flattened = value.replace(/\s+/g, " ").trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}… (+${flattened.length - limit} chars)`
}

const decodeJson = (
  text: string
): Effect.Effect<Schema.Schema.Type<typeof Schema.Json>, IntegrationCliError> =>
  Effect.tryPromise({
    try: () => Schema.decodeUnknownPromise(Schema.fromJsonString(Schema.Json))(text),
    catch: () => cliError("Invalid JSON")
  })

/** Listings stay browsable: one flattened line per tool, with the full text
 *  reachable through `wf i schema`. */
const listingDescriptionLimit = 240

const summaryForJson = (tool: ExecutorToolSummary) => ({
  name: tool.name,
  description: inline(tool.description, listingDescriptionLimit)
})

interface ToolGroup {
  readonly integration: string
  readonly connection: string
  readonly tools: Array<ExecutorToolSummary>
}

const groupTools = (tools: ReadonlyArray<ExecutorToolSummary>): ReadonlyArray<ToolGroup> => {
  const groups = new Map<string, ToolGroup>()
  for (const tool of tools) {
    const key = `${tool.integration}/${tool.connection}`
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, {
        integration: tool.integration,
        connection: tool.connection,
        tools: [tool]
      })
    } else {
      group.tools.push(tool)
    }
  }
  return [...groups.values()]
}

const formatToolGroups = (groups: ReadonlyArray<ToolGroup>): string => {
  const lines: Array<string> = []
  for (const group of groups) {
    const count = group.tools.length
    lines.push(`\n${group.integration}/${group.connection}\t${count} tool${count === 1 ? "" : "s"}`)
    for (const tool of group.tools) {
      lines.push(`${tool.name}\t${inline(tool.description, listingDescriptionLimit)}`)
    }
    // The slug an agent needs next, spelled out per group: a 53-tool listing
    // scrolls its header away long before the reader reaches the bottom.
    lines.push(`next: wf i schema ${group.integration} <tool>`)
  }
  return lines.join("\n").trimStart()
}

const formatToolDetail = (tool: ExecutorTool): string => {
  const lines = [
    tool.name,
    tool.address,
    `${tool.integration}/${tool.connection}`,
    "",
    tool.description,
    "",
    `input:\n${tool.inputTypeScript ?? JSON.stringify(tool.inputSchema ?? {}, null, 2)}`,
    "",
    `output:\n${tool.outputTypeScript ?? JSON.stringify(tool.outputSchema ?? {}, null, 2)}`,
    "",
    `next: wf i invoke ${tool.address} '<json>'`
  ]
  return lines.join("\n")
}

const connectedSummary = (
  connection: Awaited<ReturnType<typeof createExecutorConnection>>,
  toolCount: number
): string => [
  `Connected ${connection.address}`,
  `tools: ${toolCount}`,
  `next: wf i tools ${connection.integration}`
].join("\n")

const connectedResult = (
  connection: Awaited<ReturnType<typeof createExecutorConnection>>,
  tools: ReadonlyArray<ExecutorToolSummary>
) => ({
  connection,
  tools: tools.map(summaryForJson)
})

const formatDiscovery = (discovery: Awaited<ReturnType<typeof discoverIntegration>>): string => {
  const lines = [
    `url: ${discovery.url}`,
    `detected: ${discovery.detection.kind} (${discovery.detection.confidence})`,
    `integration: ${discovery.integration.slug}`,
    `auth: ${discovery.requiresAuthentication ? "required" : "none"}`
  ]
  if (discovery.authMethods.length > 0) {
    lines.push(`auth methods: ${discovery.authMethods.map((method) =>
      `${method.template}:${method.kind}`
    ).join(", ")}`)
  }
  if (discovery.requiresAuthentication && discovery.tools.length === 0) {
    lines.push(`next: wf i connect ${discovery.integration.slug}`)
  }
  lines.push(`tools: ${discovery.tools.length}`)
  if (discovery.tools.length > 0) {
    lines.push(`next: wf i tools ${discovery.integration.slug}`)
  }
  return lines.join("\n")
}

const searchSurfaceKind = (surface: IntegrationSearchSurface): string => {
  switch (surface.type) {
    case "http":
    case "openapi":
      return "openapi"
    default:
      return surface.type
  }
}

const formatSearch = (search: Awaited<ReturnType<typeof searchIntegrations>>): string => {
  if (search.results.length === 0) return `No integrations found for "${search.query}".`

  const lines = [`query: ${search.query}`]
  for (const result of search.results) {
    lines.push(`\n${result.domain}\t${inline(result.name, 120)}`)
    if (result.description.length > 0) lines.push(inline(result.description, 240))
    lines.push(`catalog: ${result.url}`)
    if (result.surfaces.length === 0) {
      lines.push("surfaces: none")
      continue
    }
    for (const surface of result.surfaces) {
      lines.push(`  ${searchSurfaceKind(surface)}\t${surface.name}`)
      if (surface.url !== undefined) lines.push(`  url: ${surface.url}`)
      if (surface.spec !== undefined) lines.push(`  spec: ${surface.spec}`)
      if (surface.discoveryUrl !== undefined) {
        lines.push(`  discover: wf i discover ${surface.discoveryUrl}`)
      }
    }
  }
  return lines.join("\n")
}

const resolveIntegration = async (target: string): Promise<ExecutorIntegration> => {
  if (URL.canParse(target)) {
    const parsed = new URL(target)
    return (await discoverIntegration(parsed.toString())).integration
  }
  const integration = (await listExecutorIntegrations()).find((entry) => entry.slug === target)
  if (integration === undefined) throw new Error(`Executor integration not found: ${target}`)
  return integration
}

const selectAuthMethod = (
  integration: ExecutorIntegration,
  template: string | undefined
): ExecutorAuthMethod => {
  const selected = template === undefined
    ? integration.authMethods.find((method) => method.kind !== "none")
    : integration.authMethods.find((method) => method.template === template)
  if (selected === undefined) {
    throw new Error(
      `No matching auth method. Available: ${integration.authMethods.map((method) =>
        `${method.template}:${method.kind}`
      ).join(", ") || "none"}`
    )
  }
  return selected
}

const assertToolsTarget = async (
  integration: string,
  connection: string
): Promise<void> => {
  const integrations = await listExecutorIntegrations()
  if (!integrations.some((candidate) => candidate.slug === integration)) {
    throw new Error(`Integration not found in catalog: ${integration}`)
  }

  const connections = await listExecutorConnections()
  if (!connections.some((candidate) =>
    candidate.integration === integration && candidate.name === connection
  )) {
    throw new Error(`Integration is not connected: ${integration}/${connection}`)
  }
}

/** Accepts whatever an agent has in hand: a tool address, an integration plus a
 *  tool name, or just the tool name it read off a listing. */
const resolveToolAddress = async (
  target: string,
  tool: string | undefined,
  connection: string
): Promise<ExecutorToolAddress> => {
  if (tool === undefined && target.startsWith("tools.")) {
    return await Schema.decodeUnknownPromise(ExecutorToolAddress)(target)
  }

  if (tool !== undefined) {
    await assertToolsTarget(target, connection)
    const summaries = await listExecutorToolSummaries({ integration: target, connection })
    const match = summaries.find((summary) => summary.name === tool)
    if (match === undefined) {
      throw new Error(
        `Tool not found: ${target}/${tool}. Run wf i tools ${target} to list its tools.`
      )
    }
    return match.address
  }

  const matches = (await listExecutorToolSummaries({ connection }))
    .filter((summary) => summary.name === target)
  const [only] = matches
  if (only !== undefined && matches.length === 1) return only.address
  if (only !== undefined) {
    throw new Error(
      `Several integrations expose ${target}. Pick one: ${matches.map((match) =>
        `wf i schema ${match.integration} ${target}`
      ).join(", ")}`
    )
  }

  const integrations = await listExecutorIntegrations()
  if (integrations.some((integration) => integration.slug === target)) {
    throw new Error(
      `${target} is an integration, not a tool. Run wf i tools ${target}, then wf i schema ${target} <tool>.`
    )
  }
  throw new Error(`Tool not found: ${target}. Run wf i tools to browse tool names.`)
}

const makeDiscover = () => Command.make(
  "discover",
  {
    url: Argument.string("url").pipe(
      Argument.withDescription("MCP endpoint or OpenAPI document URL")
    ),
    connection: Flag.string("connection").pipe(
      Flag.withDefault("default"),
      Flag.withDescription("Connection name for unauthenticated tools")
    ),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    )
  },
  ({ url, connection, text }) =>
    Effect.tryPromise({
      try: () => discoverIntegration(url, { connection }),
      catch: (error) => cliError(
        `Integration discovery failed: ${error instanceof Error ? errorMessage(error) : String(error)}`
      )
    }).pipe(
      Effect.flatMap((result) =>
        writeStdoutLine(text ? formatDiscovery(result) : JSON.stringify(result, null, 2))
      )
    )
).pipe(
  Command.withDescription("Detect and register an integration")
)

const makeSearch = () => Command.make(
  "search",
  {
    query: Argument.string("query").pipe(
      Argument.withDescription("Service name, domain, or integration keyword")
    ),
    kind: Flag.choice("kind", ["mcp", "openapi", "graphql", "cli"]).pipe(
      Flag.optional,
      Flag.withDescription("Limit results to one integration kind")
    ),
    limit: Flag.integer("limit").pipe(
      Flag.withDefault(5),
      Flag.withDescription("Maximum results (default: 5, range: 1-100)")
    ),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    )
  },
  ({ query, kind, limit, text }) => Effect.tryPromise({
    try: () => searchIntegrations({
      q: query,
      ...(Option.isNone(kind) ? {} : { kind: kind.value }),
      limit
    }),
    catch: (error) => cliError(
      `Integration search failed: ${error instanceof Error ? errorMessage(error) : String(error)}`
    )
  }).pipe(
    Effect.flatMap((result) => writeStdoutLine(text ? formatSearch(result) : JSON.stringify(result, null, 2)))
  )
).pipe(Command.withDescription("Search integrations.sh for exact integration URLs"))

const makeList = () => Command.make(
  "list",
  {
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    )
  },
  ({ text }) => Effect.tryPromise({
    try: () => listExecutorIntegrations(),
    catch: (error) => cliError(`Could not list integrations: ${String(error)}`)
  }).pipe(
    Effect.flatMap((integrations) => writeStdoutLine(
      text
        ? integrations.map((integration) =>
            `${integration.slug}\t${integration.kind}\t${integration.name}\t${integration.authMethods.map((method) => method.kind).join(",")}`
          ).join("\n") || "No integrations discovered."
        : JSON.stringify({ integrations }, null, 2)
    ))
  )
).pipe(Command.withDescription("List Executor's persisted integration catalog"))

const makeTools = () => Command.make(
  "tools",
  {
    integration: Argument.string("integration").pipe(Argument.optional),
    integrationFlag: Flag.string("integration").pipe(
      Flag.optional,
      Flag.withDescription("Deprecated: use the positional integration argument")
    ),
    search: Flag.string("search").pipe(
      Flag.optional,
      Flag.withDescription("Only list tools whose name or description contains this text")
    ),
    connection: Flag.string("connection").pipe(
      Flag.withDefault("default"),
      Flag.withDescription("Connection name (default: default)")
    ),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    )
  },
  ({ integration, integrationFlag, search, connection, text }) => Effect.gen(function*() {
    const positional = Option.getOrUndefined(integration)
    const flagged = Option.getOrUndefined(integrationFlag)
    if (positional !== undefined && flagged !== undefined) {
      return yield* cliError("Provide the integration either positionally or with --integration, not both")
    }
    const selected = positional ?? flagged
    if (selected !== undefined) {
      yield* Effect.tryPromise({
        try: () => assertToolsTarget(selected, connection),
        catch: (error) => cliError(error instanceof Error ? error.message : String(error))
      })
    }
    const tools = yield* Effect.tryPromise({
      try: () => listExecutorToolSummaries({
        ...(selected === undefined ? {} : { integration: selected }),
        connection
      }),
      catch: (error) => cliError(`Could not list tools: ${String(error)}`)
    })
    const term = Option.getOrUndefined(search)?.toLowerCase()
    const matching = term === undefined
      ? tools
      : tools.filter((tool) =>
        tool.name.toLowerCase().includes(term) || tool.description.toLowerCase().includes(term)
      )
    const groups = groupTools(matching)
    yield* writeStdoutLine(
      text
        ? groups.length === 0
          ? term === undefined ? "No tools available." : `No tools match "${term}".`
          : formatToolGroups(groups)
        : JSON.stringify({
          integrations: groups.map((group) => ({
            integration: group.integration,
            connection: group.connection,
            tools: group.tools.map(summaryForJson)
          }))
        }, null, 2)
    )
  })
).pipe(Command.withDescription("List tool names and descriptions per integration"))

const makeSchema = () => Command.make(
  "schema",
  {
    target: Argument.string("target").pipe(
      Argument.withDescription("Tool name, integration slug, or tool address")
    ),
    tool: Argument.string("tool").pipe(
      Argument.optional,
      Argument.withDescription("Tool name, when the first argument is an integration")
    ),
    connection: Flag.string("connection").pipe(
      Flag.withDefault("default"),
      Flag.withDescription("Connection name (default: default)")
    ),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    )
  },
  ({ target, tool, connection, text }) => Effect.gen(function*() {
    const address = yield* Effect.tryPromise({
      try: () => resolveToolAddress(target, Option.getOrUndefined(tool), connection),
      catch: (error) => cliError(error instanceof Error ? errorMessage(error) : String(error))
    })
    const detail = yield* Effect.tryPromise({
      try: () => describeExecutorTool(address),
      catch: (error) => cliError(
        `Could not read tool schema: ${error instanceof Error ? errorMessage(error) : String(error)}`
      )
    })
    yield* writeStdoutLine(
      text ? formatToolDetail(detail) : JSON.stringify(detail, null, 2)
    )
  })
).pipe(Command.withDescription("Show one tool's description and input/output schemas"))

const makeConnect = (options: IntegrationsCliOptions) => Command.make(
  "connect",
  {
    target: Argument.string("integration-or-url"),
    connection: Flag.string("connection").pipe(Flag.withDefault("default")),
    template: Flag.string("template").pipe(Flag.optional),
    credentialEnv: Flag.string("credential-env").pipe(
      Flag.optional,
      Flag.withDescription("Environment variable containing an API key or bearer token")
    ),
    scopes: Flag.string("scopes").pipe(Flag.optional),
    clientId: Flag.string("client-id").pipe(Flag.optional),
    clientSecretEnv: Flag.string("client-secret-env").pipe(Flag.optional),
    noOpen: Flag.boolean("no-open"),
    timeout: Flag.integer("timeout").pipe(Flag.withDefault(300)),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    )
  },
  ({
    target,
    connection,
    template,
    credentialEnv,
    scopes,
    clientId,
    clientSecretEnv,
    noOpen,
    timeout,
    text
  }) => Effect.tryPromise({
    try: async () => {
      const integration = await resolveIntegration(target)
      const method = selectAuthMethod(integration, Option.getOrUndefined(template))
      if (method.kind === "oauth") {
        const clientSecretName = Option.getOrUndefined(clientSecretEnv)
        const clientSecret = clientSecretName === undefined
          ? undefined
          : process.env[clientSecretName]
        if (clientSecretName !== undefined && clientSecret === undefined) {
          throw new Error(`Environment variable ${clientSecretName} is not set`)
        }
        const scopeText = Option.getOrUndefined(scopes)
        const connected = await authorizeExecutorInBrowser({
          integration: integration.slug,
          connection,
          authMethod: method,
          timeoutMs: Math.max(1, timeout) * 1000,
          ...(scopeText === undefined
            ? {}
            : { scopes: scopeText.split(/[\s,]+/).filter((scope) => scope.length > 0) }),
          ...Option.match(clientId, {
            onNone: () => ({}),
            onSome: (value) => ({ clientId: value })
          }),
          ...(clientSecret === undefined ? {} : { clientSecret }),
          open: noOpen ? () => undefined : (options.openBrowser ?? openBrowser),
          onAuthorizationUrl: (url) => console.error(`Authorize in your browser:\n${url}`)
        })
        const tools = await listExecutorToolSummaries({
          integration: integration.slug,
          connection: connected.name
        })
        return connectedResult(connected, tools)
      }
      const envName = Option.getOrUndefined(credentialEnv)
      if (envName === undefined) {
        throw new Error(`Auth method ${method.template} requires --credential-env`)
      }
      const credential = process.env[envName]
      if (credential === undefined) throw new Error(`Environment variable ${envName} is not set`)
      const connected = await createExecutorConnection({
        integration: integration.slug,
        name: connection,
        template: method.template,
        value: credential
      })
      const tools = await listExecutorToolSummaries({
        integration: integration.slug,
        connection: connected.name
      })
      return connectedResult(connected, tools)
    },
    catch: (error) => cliError(
      `Connection failed: ${error instanceof Error ? errorMessage(error) : String(error)}`
    )
  }).pipe(Effect.flatMap((result) => writeStdoutLine(
    text
      ? connectedSummary(result.connection, result.tools.length)
      : JSON.stringify(result, null, 2)
  )))
).pipe(Command.withDescription("Authorize an Executor integration"))

const makeConnections = () => Command.make(
  "connections",
  {
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    )
  },
  ({ text }) => Effect.tryPromise({
    try: () => listExecutorConnections(),
    catch: (error) => cliError(`Could not list connections: ${String(error)}`)
  }).pipe(
    Effect.flatMap((connections) => writeStdoutLine(
      text
        ? connections.map((connection) =>
            `${connection.integration}\t${connection.name}\t${connection.template}\t${connection.address}`
          ).join("\n") || "No connected integrations."
        : JSON.stringify({ connections }, null, 2)
    ))
  )
).pipe(Command.withDescription("List Executor connections without exposing credentials"))

const makeDisconnect = () => Command.make(
  "disconnect",
  {
    integration: Argument.string("integration"),
    connection: Flag.string("connection").pipe(Flag.withDefault("default")),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    )
  },
  ({ integration, connection, text }) => Effect.tryPromise({
    try: () => removeExecutorConnection({ integration, name: connection }),
    catch: (error) => cliError(`Disconnect failed: ${String(error)}`)
  }).pipe(Effect.flatMap(() => writeStdoutLine(
    text
      ? `Disconnected ${integration}/${connection}`
      : JSON.stringify({ disconnected: true, integration, connection }, null, 2)
  )))
).pipe(Command.withDescription("Delete an Executor connection"))

const makeInvoke = () => Command.make(
  "invoke",
  {
    address: Argument.string("tool-address"),
    input: Argument.string("json").pipe(Argument.optional),
    file: Flag.string("file").pipe(
      Flag.optional,
      Flag.withDescription("Read the JSON input from a file")
    )
  },
  ({ address, input, file }) => Effect.gen(function*() {
    const inlineInput = Option.getOrUndefined(input)
    const filePath = Option.getOrUndefined(file)
    if (inlineInput !== undefined && filePath !== undefined) {
      return yield* cliError("Provide JSON input or --file, not both")
    }
    const source = filePath === undefined
      ? inlineInput ?? "{}"
      : yield* Effect.tryPromise({
        try: () => Bun.file(filePath).text(),
        catch: () => cliError(`Could not read integration input: ${filePath}`)
      })
    const payload = yield* decodeJson(source)
    const result = yield* Effect.tryPromise({
      try: async () => {
        const decodedAddress = await Schema.decodeUnknownPromise(ExecutorToolAddress)(address)
        return await executeExecutorTool(decodedAddress, payload)
      },
      catch: (error) => cliError(`Invocation failed: ${String(error)}`)
    })
    yield* writeStdoutLine(JSON.stringify(result, null, 2))
  })
).pipe(Command.withDescription("Invoke an Executor tool with JSON input"))

const makeValidate = () => Command.make(
  "validate",
  {
    config: Argument.string("json-or-tool-address").pipe(Argument.optional),
    file: Flag.string("file").pipe(Flag.optional),
    live: Flag.boolean("live"),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    )
  },
  ({ config, file, live, text }) => Effect.gen(function*() {
    const configText = Option.getOrUndefined(config)
    const filePath = Option.getOrUndefined(file)
    if ((configText === undefined) === (filePath === undefined)) {
      return yield* cliError("Provide exactly one of a JSON config or --file")
    }
    const directAddress = configText?.startsWith("tools.") === true
    let source: string
    if (filePath === undefined) {
      if (configText === undefined) return yield* cliError("Provide a JSON config")
      source = directAddress
        ? JSON.stringify({ source: { kind: "executor", address: configText } })
        : configText
    } else {
      source = yield* Effect.tryPromise({
        try: () => Bun.file(filePath).text(),
        catch: () => cliError(`Could not read integration configuration: ${filePath}`)
      })
    }
    const node = yield* decodeJson(source)
    const report = yield* Effect.tryPromise({
      try: () => validateIntegrationNode(node, { live: live || directAddress }),
      catch: (error) => cliError(`Integration validation failed: ${String(error)}`)
    })
    yield* writeStdoutLine(
      text
        ? report.findings.map((entry) =>
            `${entry.severity}\t${entry.check}\t${entry.message}`
          ).join("\n")
        : JSON.stringify(report, null, 2)
    )
    if (!report.ok) return yield* cliError("Integration validation failed")
  })
).pipe(Command.withDescription("Validate an Executor tool address or integration config"))

export const makeIntegrationsCommand = (options: IntegrationsCliOptions = {}) =>
  Command.make("integrations").pipe(
    Command.withDescription("Discover, authorize, inspect, and invoke through Executor"),
    Command.withAlias("i"),
    Command.withSubcommands([
      makeDiscover(),
      makeSearch(),
      makeList(),
      makeTools(),
      makeSchema(),
      makeConnect(options),
      makeConnections(),
      makeDisconnect(),
      makeInvoke(),
      makeValidate()
    ])
  )
