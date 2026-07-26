import path from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Console, Data, Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import {
  connectionManagerPaths,
  createConnectionManager
} from "../connections.ts"
import type {
  ConnectionManager,
  OAuthClientConfiguration
} from "../connections.ts"
import { envSecretResolver } from "../core.ts"
import {
  auth,
  discoverMcpServer,
  resolveAuthorizationHeaders
} from "../integration.ts"
import type { McpServerDiscovery } from "../integration.ts"
import { discoverOpenApi } from "../openapi.ts"
import type { OpenApiDiscovery, OpenApiOperation } from "../openapi.ts"
import { discover, getIntegrationSurface, validateIntegrationNode } from "../sdk/integrations.ts"
import type { IntegrationSurfaceDocument } from "../sdk/integrations.ts"
import { authorizeMcpInBrowser, openBrowser } from "./oauth.ts"

class IntegrationCliError extends Data.TaggedError("IntegrationCliError")<{
  readonly message: string
}> {}

export interface IntegrationsCliOptions {
  readonly storageDir?: string
  readonly registryBaseUrl?: string
  readonly openBrowser?: (url: string) => void | Promise<void>
}

const cliError = (message: string): IntegrationCliError => new IntegrationCliError({ message })
const errorMessage = (error: Error): string => error.message

const decodeJson = (text: string): Effect.Effect<Schema.Schema.Type<typeof Schema.Json>, IntegrationCliError> =>
  Effect.tryPromise({
    try: () => Schema.decodeUnknownPromise(Schema.Json)(JSON.parse(text)),
    catch: () => cliError("Invalid JSON input")
  })

const managerFor = (options: IntegrationsCliOptions): ConnectionManager => {
  const paths = connectionManagerPaths(options.storageDir ?? path.join(process.cwd(), ".wf"))
  return createConnectionManager(paths)
}

const registryOptions = (options: IntegrationsCliOptions): { readonly baseUrl?: string } =>
  options.registryBaseUrl === undefined ? {} : { baseUrl: options.registryBaseUrl }

const credentialForSurface = (
  surface: NonNullable<IntegrationSurfaceDocument["surfaces"]>[number]
): string | undefined => surface.auth?.entries?.flatMap((entry) => entry.use ?? [])[0]?.id

const formatIntegrationSurface = (surface: IntegrationSurfaceDocument): string => {
  const lines = [surface.summary ?? surface.description ?? "No summary."]
  for (const entry of surface.surfaces ?? []) {
    lines.push(`\n${entry.name ?? entry.slug ?? entry.type} (${entry.type})${entry.url === undefined ? "" : `\n${entry.url}`}`)
    if (entry.spec !== undefined) lines.push(`spec: ${entry.spec}`)
    if (entry.docs !== undefined) lines.push(`docs: ${entry.docs}`)
    if (entry.transports !== undefined) lines.push(`transports: ${entry.transports.join(", ")}`)
    if (entry.requiredHeaders !== undefined) {
      lines.push(`required headers: ${entry.requiredHeaders.map((header) => header.name).join(", ")}`)
    }
    if (entry.auth !== undefined) {
      const uses = entry.auth.entries?.flatMap((authEntry) => authEntry.use ?? []) ?? []
      const formattedUses = uses.map((use) => {
        const headerName = use.mechanics?.headerName
        const scheme = use.mechanics?.scheme
        return `${use.id}${headerName === undefined ? "" : `: ${headerName}${scheme === undefined ? "" : ` ${scheme}`}`}`
      }).join(", ")
      lines.push(`auth: ${entry.auth.status ?? "unknown"}${formattedUses.length === 0 ? "" : ` (${formattedUses})`}`)
    }
    if (entry.type === "mcp" && entry.url !== undefined) {
      const credential = credentialForSurface(entry)
      lines.push(`inspect: wf integrations inspect-mcp ${surface.domain}${credential === undefined ? "" : ` --connection ${credential}`}`)
      if (entry.auth?.status === "required") lines.push(`connect: wf integrations connect ${surface.domain}${credential === undefined ? "" : ` --connection ${credential}`}`)
    }
    if (entry.type === "http" && entry.spec !== undefined) {
      lines.push(`inspect: wf integrations inspect-openapi ${surface.domain}`)
    }
  }
  if (surface.credentials !== undefined) {
    lines.push("\nCredentials:")
    for (const [id, credential] of Object.entries(surface.credentials)) {
      lines.push(`${id}\t${credential.type ?? "unknown"}\t${credential.acquisition ?? "unknown"}\t${credential.label ?? ""}\t${credential.generateUrl ?? ""}\t${credential.setup?.split("\n")[0] ?? ""}`)
    }
  }
  return lines.join("\n")
}

interface McpTarget {
  readonly url: string
  readonly domain?: string
  readonly connectionId: string
  readonly authRequired: boolean
}

const resolveMcpTarget = async (
  target: string,
  options: IntegrationsCliOptions
): Promise<McpTarget> => {
  try {
    const url = new URL(target)
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol")
    return {
      url: url.toString(),
      connectionId: url.hostname,
      authRequired: false
    }
  } catch {
    const surface = await getIntegrationSurface(target, registryOptions(options))
    const mcp = surface.surfaces?.find((entry) => entry.type === "mcp" && entry.url !== undefined)
    if (mcp?.url === undefined) throw new Error(`No MCP surface is registered for ${target}`)
    return {
      url: mcp.url,
      domain: surface.domain,
      connectionId: credentialForSurface(mcp) ?? `${surface.domain}-oauth`,
      authRequired: mcp.auth?.status === "required"
    }
  }
}

interface OpenApiTarget {
  readonly spec: string
  readonly domain?: string
}

const resolveOpenApiTarget = async (
  target: string,
  options: IntegrationsCliOptions
): Promise<OpenApiTarget> => {
  try {
    const url = new URL(target)
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol")
    return { spec: url.toString() }
  } catch {
    const surface = await getIntegrationSurface(target, registryOptions(options))
    const http = surface.surfaces?.find((entry) => entry.type === "http" && entry.spec !== undefined)
    if (http?.spec === undefined) throw new Error(`No machine-readable OpenAPI spec is registered for ${target}`)
    return { spec: http.spec, domain: surface.domain }
  }
}

const formatMcpDiscovery = (
  discovery: McpServerDiscovery,
  connectionId: string,
  authenticated: boolean
): string => {
  const lines = [`MCP ${discovery.url}`, `protocol: ${discovery.protocolVersion}`, `tools: ${discovery.tools.length}`]
  for (const tool of discovery.tools) {
    lines.push(`\n${tool.name}${tool.description === undefined ? "" : `\n${tool.description}`}`)
    if (tool.inputSchema !== undefined) lines.push(`input: ${JSON.stringify(tool.inputSchema)}`)
    if (tool.outputSchema !== undefined) lines.push(`output: ${JSON.stringify(tool.outputSchema)}`)
    lines.push("integration({")
    lines.push(`  source: { kind: "mcp", url: ${JSON.stringify(discovery.url)} },`)
    lines.push(`  operation: ${JSON.stringify(tool.name)},`)
    if (authenticated) lines.push(`  auth: { kind: "bearer", credential: auth(${JSON.stringify(connectionId)}) },`)
    lines.push("  input: t.struct({ /* derive from input above */ }),")
    lines.push("  output: t.struct({ /* derive from output above */ })")
    lines.push("})")
  }
  return lines.join("\n")
}

const operationSource = (discovery: OpenApiDiscovery, operation: OpenApiOperation): string => {
  const unresolved = operation.parameters.filter((parameter) => parameter.location === "reference")
  if (unresolved.length > 0) {
    throw new Error(`unresolved parameter references: ${unresolved.map((parameter) => parameter.reference ?? parameter.name).join(", ")}`)
  }
  if (operation.requestBody !== undefined && !operation.requestBody.contentTypes.includes("application/json")) {
    throw new Error(`unsupported request body media types: ${operation.requestBody.contentTypes.join(", ") || "none"}`)
  }
  const parameters = operation.parameters
    .filter((parameter) => parameter.location !== "reference")
    .map((parameter) => ({ name: parameter.name, in: parameter.location }))
  const source = {
    kind: "openapi",
    url: operation.server,
    method: operation.method,
    path: operation.path,
    spec: discovery.specUrl,
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(operation.requestBody === undefined ? {} : { body: "body", contentType: "application/json" })
  }
  return JSON.stringify(source, null, 2).split("\n").map((line, index) => index === 0 ? line : `  ${line}`).join("\n")
}

const formatOpenApiDiscovery = (discovery: OpenApiDiscovery): string => {
  const lines = [
    `${discovery.title ?? "OpenAPI"}${discovery.version === undefined ? "" : ` ${discovery.version}`}`,
    `spec: ${discovery.specUrl}`,
    `operations: ${discovery.operations.length}`
  ]
  for (const operation of discovery.operations) {
    lines.push(`\n${operation.operationId}\t${operation.method} ${operation.path}${operation.summary === undefined ? "" : `\t${operation.summary}`}`)
    for (const parameter of operation.parameters) {
      lines.push(`parameter: ${parameter.location} ${parameter.name}${parameter.required ? " required" : " optional"}`)
    }
    if (operation.requestBody !== undefined) lines.push(`body: ${operation.requestBody.required ? "required" : "optional"} ${operation.requestBody.contentTypes.join(",")}`)
    const security = operation.security.flatMap((requirement) => requirement.schemes.map((scheme) => `${scheme.name}${scheme.scopes.length === 0 ? "" : `(${scheme.scopes.join(",")})`}`))
    if (security.length > 0) lines.push(`security: ${security.join(" or ")}`)
    try {
      lines.push("integration({")
      lines.push(`  source: ${operationSource(discovery, operation)},`)
      lines.push(`  operation: ${JSON.stringify(operation.operationId)},`)
      lines.push("  input: t.struct({ /* derive from parameters/body above */ }),")
      lines.push("  output: t.struct({ /* derive from response schema */ })")
      lines.push("})")
    } catch (error) {
      lines.push(`integration unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return lines.join("\n")
}

const makeIntegrationSearch = (options: IntegrationsCliOptions) => Command.make(
  "search",
  {
    term: Argument.string("term").pipe(Argument.withDescription("Service, domain, or capability to search for")),
    kind: Flag.choice("kind", ["mcp", "openapi", "graphql", "cli"]).pipe(
      Flag.optional,
      Flag.withDescription("Limit results to one integration surface kind")
    ),
    limit: Flag.integer("limit").pipe(
      Flag.withDefault(20),
      Flag.withDescription("Maximum number of results to return")
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("Print the complete result as JSON"))
  },
  ({ term, kind, limit, json }) =>
    Effect.tryPromise({
      try: () => discover(term, {
        ...Option.match(kind, { onNone: () => ({}), onSome: (value) => ({ kind: value }) }),
        limit,
        ...registryOptions(options)
      }),
      catch: (error) => cliError(`Integration discovery failed: ${error instanceof Error ? errorMessage(error) : String(error)}`)
    }).pipe(
      Effect.flatMap((result) => {
        if (json) return Console.log(JSON.stringify(result, null, 2))
        if (result.results.length === 0) return Console.log("No integrations found.")
        return Console.log(`${result.results.map((entry) => `${entry.domain}\t${entry.kinds.join(",")}\t${entry.description}`).join("\n")}\nrun: wf integrations show <domain>`)
      })
    )
).pipe(
  Command.withDescription("Search integrations.sh for agent-ready integration surfaces"),
  Command.withExamples([{ command: "wf integrations search linear --kind mcp", description: "Find Linear MCP servers" }])
)

const makeIntegrationShow = (options: IntegrationsCliOptions) => Command.make(
  "show",
  {
    domain: Argument.string("domain").pipe(Argument.withDescription("Integration domain, such as linear.app")),
    json: Flag.boolean("json").pipe(Flag.withDescription("Print the complete surface document as JSON"))
  },
  ({ domain, json }) =>
    Effect.tryPromise({
      try: () => getIntegrationSurface(domain, registryOptions(options)),
      catch: (error) => cliError(`Integration surface lookup failed: ${error instanceof Error ? errorMessage(error) : String(error)}`)
    }).pipe(
      Effect.flatMap((surface) => Console.log(json ? JSON.stringify(surface, null, 2) : formatIntegrationSurface(surface)))
    )
).pipe(Command.withDescription("Show the available surfaces and credentials for an integration"))

const makeInspectMcp = (options: IntegrationsCliOptions) => Command.make(
  "inspect-mcp",
  {
    target: Argument.string("domain-or-url").pipe(Argument.withDescription("Registry domain or MCP endpoint URL")),
    connection: Flag.string("connection").pipe(Flag.optional, Flag.withDescription("Connected credential id to use")),
    json: Flag.boolean("json").pipe(Flag.withDescription("Print complete tool schemas as JSON"))
  },
  ({ target, connection, json }) => Effect.tryPromise({
    try: async () => {
      const resolved = await resolveMcpTarget(target, options)
      const connectionId = Option.getOrUndefined(connection) ?? resolved.connectionId
      const manager = managerFor(options)
      let headers: Record<string, string> = {}
      const authenticated = manager.get(connectionId) !== undefined
      if (authenticated) {
        headers = await resolveAuthorizationHeaders(
          { kind: "bearer", credential: auth(connectionId) },
          async (name, context) => await manager.secretResolver(envSecretResolver()).resolve(name, context),
          resolved.url
        )
      } else if (resolved.authRequired) {
        throw new Error(`MCP surface requires authorization. Run: wf integrations connect ${resolved.domain ?? resolved.url} --connection ${connectionId}`)
      }
      const discovery = await discoverMcpServer(resolved.url, headers)
      return json ? JSON.stringify(discovery, null, 2) : formatMcpDiscovery(discovery, connectionId, authenticated)
    },
    catch: (error) => cliError(`MCP inspection failed: ${error instanceof Error ? errorMessage(error) : String(error)}`)
  }).pipe(Effect.flatMap(Console.log))
).pipe(Command.withDescription("Inspect an MCP server and list complete tool schemas"))

const makeInspectOpenApi = (options: IntegrationsCliOptions) => Command.make(
  "inspect-openapi",
  {
    target: Argument.string("domain-or-spec-url").pipe(Argument.withDescription("Registry domain or OpenAPI document URL")),
    operation: Flag.string("operation").pipe(Flag.optional, Flag.withDescription("Show one operation id")),
    json: Flag.boolean("json").pipe(Flag.withDescription("Print complete operation schemas as JSON"))
  },
  ({ target, operation, json }) => Effect.tryPromise({
    try: async () => {
      const resolved = await resolveOpenApiTarget(target, options)
      const discovery = await discoverOpenApi(resolved.spec)
      const operationId = Option.getOrUndefined(operation)
      const selected = operationId === undefined
        ? discovery
        : { ...discovery, operations: discovery.operations.filter((entry) => entry.operationId === operationId) }
      if (operationId !== undefined && selected.operations.length === 0) throw new Error(`OpenAPI operation not found: ${operationId}`)
      return json ? JSON.stringify(selected, null, 2) : formatOpenApiDiscovery(selected)
    },
    catch: (error) => cliError(`OpenAPI inspection failed: ${error instanceof Error ? errorMessage(error) : String(error)}`)
  }).pipe(Effect.flatMap(Console.log))
).pipe(Command.withDescription("Fetch an OpenAPI document and inspect its operation schemas"))

const makeConnect = (options: IntegrationsCliOptions) => Command.make(
  "connect",
  {
    target: Argument.string("domain-or-mcp-url").pipe(Argument.withDescription("Registry domain or OAuth-protected MCP URL")),
    connection: Flag.string("connection").pipe(Flag.optional, Flag.withDescription("Stable id referenced by auth(...)")),
    scopes: Flag.string("scopes").pipe(Flag.optional, Flag.withDescription("Space- or comma-separated OAuth scopes")),
    clientId: Flag.string("client-id").pipe(Flag.optional, Flag.withDescription("Pre-registered OAuth client id; defaults to dynamic registration")),
    clientSecretEnv: Flag.string("client-secret-env").pipe(Flag.optional, Flag.withDescription("Environment variable containing a registered client secret")),
    noOpen: Flag.boolean("no-open").pipe(Flag.withDescription("Print the authorization URL without opening a browser")),
    timeout: Flag.integer("timeout").pipe(Flag.withDefault(300), Flag.withDescription("Authorization timeout in seconds"))
  },
  ({ target, connection, scopes, clientId, clientSecretEnv, noOpen, timeout }) => Effect.tryPromise({
    try: async () => {
      if (timeout < 1) throw new Error("--timeout must be at least one second")
      const resolved = await resolveMcpTarget(target, options)
      const connectionId = Option.getOrUndefined(connection) ?? resolved.connectionId
      const scopeText = Option.getOrUndefined(scopes)
      const requestedScopes = scopeText === undefined
        ? undefined
        : scopeText.split(/[\s,]+/).map((scope) => scope.trim()).filter((scope) => scope.length > 0)
      const configuredClientId = Option.getOrUndefined(clientId)
      const secretEnv = Option.getOrUndefined(clientSecretEnv)
      if (configuredClientId === undefined && secretEnv !== undefined) throw new Error("--client-secret-env requires --client-id")
      const clientSecret = secretEnv === undefined ? undefined : process.env[secretEnv]
      if (secretEnv !== undefined && clientSecret === undefined) throw new Error(`Environment variable ${secretEnv} is not set`)
      const client: OAuthClientConfiguration | undefined = configuredClientId === undefined
        ? undefined
        : {
            type: "static",
            clientId: configuredClientId,
            ...(clientSecret === undefined ? {} : { clientSecret })
          }
      const manager = managerFor(options)
      const connected = await authorizeMcpInBrowser({
        manager,
        connectionId,
        resource: resolved.url,
        ...(requestedScopes === undefined ? {} : { scopes: requestedScopes }),
        ...(client === undefined ? {} : { client }),
        open: noOpen ? () => undefined : (options.openBrowser ?? openBrowser),
        onAuthorizationUrl: (url) => console.log(`Authorize ${connectionId} in your browser:\n${url}`),
        timeoutMs: timeout * 1000
      })
      return `Connected ${connected.id} to ${connected.resource}\nworkflow auth: auth(${JSON.stringify(connected.id)})`
    },
    catch: (error) => cliError(`Connection failed: ${error instanceof Error ? errorMessage(error) : String(error)}`)
  }).pipe(Effect.flatMap(Console.log))
).pipe(Command.withDescription("Authorize an MCP integration in the browser with OAuth + PKCE"))

const makeConnections = (options: IntegrationsCliOptions) => Command.make(
  "connections",
  { json: Flag.boolean("json").pipe(Flag.withDescription("Print connection metadata as JSON")) },
  ({ json }) => Effect.sync(() => managerFor(options).list()).pipe(
    Effect.flatMap((connections) => {
      if (json) return Console.log(JSON.stringify({ connections }, null, 2))
      if (connections.length === 0) return Console.log("No connected integrations.")
      return Console.log(connections.map((connection) =>
        `${connection.id}\t${connection.status}\t${connection.resource}\t${connection.scopes.join(",")}`
      ).join("\n"))
    })
  )
).pipe(Command.withDescription("List connected integrations without exposing tokens"))

const makeDisconnect = (options: IntegrationsCliOptions) => Command.make(
  "disconnect",
  { connection: Argument.string("connection-id").pipe(Argument.withDescription("Connected credential id")) },
  ({ connection }) => Effect.sync(() => managerFor(options).disconnect(connection)).pipe(
    Effect.flatMap((deleted) => deleted
      ? Console.log(`Disconnected ${connection}`)
      : Effect.fail(cliError(`Connection not found: ${connection}`)))
  )
).pipe(Command.withDescription("Delete a connected integration and its encrypted credentials"))

const makeIntegrationValidate = (options: IntegrationsCliOptions) => Command.make(
  "validate",
  {
    config: Argument.string("json").pipe(
      Argument.optional,
      Argument.withDescription("Integration node configuration as JSON")
    ),
    file: Flag.string("file").pipe(Flag.optional, Flag.withDescription("Read the integration node configuration from a file")),
    input: Flag.string("input").pipe(Flag.optional, Flag.withDescription("Sample input JSON for a live validation")),
    live: Flag.boolean("live").pipe(Flag.withDescription("Inspect the MCP or OpenAPI endpoint")),
    json: Flag.boolean("json").pipe(Flag.withDescription("Print the validation report as JSON"))
  },
  ({ config, file, input, live, json }) =>
    Effect.gen(function*() {
      const configText = Option.getOrUndefined(config)
      const filePath = Option.getOrUndefined(file)
      if ((configText === undefined) === (filePath === undefined)) {
        return yield* cliError("Provide exactly one of a JSON config or --file")
      }
      const source = filePath === undefined
        ? configText!
        : yield* Effect.tryPromise({
          try: () => Bun.file(filePath).text(),
          catch: () => cliError(`Could not read integration configuration: ${filePath}`)
        })
      const node = yield* decodeJson(source)
      const inputText = Option.getOrUndefined(input)
      const sampleInput = inputText === undefined ? undefined : yield* decodeJson(inputText)
      const resolver = managerFor(options).secretResolver(envSecretResolver())
      const report = yield* Effect.tryPromise({
        try: () => validateIntegrationNode(node, {
          live,
          ...registryOptions(options),
          resolveSecret: resolver.resolve,
          ...(sampleInput === undefined ? {} : { sampleInput })
        }),
        catch: (error) => cliError(`Integration validation failed: ${error instanceof Error ? errorMessage(error) : String(error)}`)
      })
      yield* Console.log(json ? JSON.stringify(report, null, 2) : report.findings.map((entry) => `${entry.severity}\t${entry.check}\t${entry.message}`).join("\n"))
      if (!report.ok) return yield* cliError("Integration validation failed")
    })
).pipe(Command.withDescription("Validate an integration node before adding it to a workflow"))

const integrationsCommand = (options: IntegrationsCliOptions) => Command.make("integrations").pipe(
  Command.withDescription("Discover, authorize, inspect, and validate integration surfaces"),
  Command.withSubcommands([
    makeIntegrationSearch(options),
    makeIntegrationShow(options),
    makeInspectMcp(options),
    makeInspectOpenApi(options),
    makeConnect(options),
    makeConnections(options),
    makeDisconnect(options),
    makeIntegrationValidate(options)
  ])
)

export const runIntegrationsCli = (
  arguments_: ReadonlyArray<string>,
  options: IntegrationsCliOptions = {}
): Promise<void> => Effect.runPromise(
  Command.runWith(integrationsCommand(options), { version: "0.2.0" })(arguments_).pipe(
    Effect.catchTag("ShowHelp", (error) => error.errors.length === 0
      ? Effect.void
      : Effect.sync(() => { process.exitCode = 1 })),
    Effect.provide(BunServices.layer)
  )
)
