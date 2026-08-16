import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { generateModule } from "@mokronos/integrations-client"
import type { CodegenTarget, GatewayClient } from "@mokronos/integrations-client"
import { cliError, connectToGateway, describeError, openBrowser } from "./connection.ts"
import type { IntegrationsCliError } from "./connection.ts"
import {
  inline,
  jsonOutput,
  moreHint,
  truncate,
  visibleItems,
  withNext,
  writeStdoutLine
} from "./output.ts"

const verboseFlag = () =>
  Flag.boolean("verbose").pipe(
    Flag.withAlias("v"),
    Flag.withDescription("Show complete details")
  )

const textFlag = () =>
  Flag.boolean("text").pipe(Flag.withDescription("Print a human-readable result"))

const connectionFlag = () =>
  Flag.string("connection").pipe(
    Flag.withDefault("default"),
    Flag.withDescription("Connection name (default: default)")
  )

const gatewayTask = <A>(
  task: (client: GatewayClient) => Promise<A>
): Effect.Effect<A, IntegrationsCliError> =>
  Effect.tryPromise({
    try: async () => await task(await connectToGateway()),
    catch: (error) => cliError(describeError(error))
  })

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {}

const array = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) ? value.map(record) : []

const text = (value: unknown): string => value === undefined || value === null ? "" : String(value)

const readJsonArgument = async (
  inline_: string | undefined,
  file: string | undefined
): Promise<unknown> => {
  if (inline_ !== undefined && file !== undefined) {
    throw cliError("Provide JSON input or --file, not both")
  }
  const source = file === undefined ? inline_ ?? "{}" : await Bun.file(file).text()
  try {
    return JSON.parse(source)
  } catch (error) {
    throw cliError(`Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// --- catalog ----------------------------------------------------------------

const discoverCommand = Command.make(
  "discover",
  {
    url: Argument.string("url").pipe(
      Argument.withDescription("MCP endpoint or OpenAPI document URL")
    ),
    connection: connectionFlag(),
    text: textFlag(),
    verbose: verboseFlag()
  },
  ({ url, connection, text: asText, verbose }) =>
    gatewayTask((client) => client.request("POST", "/v1/integrations/discover", { url, connection }))
      .pipe(Effect.flatMap((result) => {
        const body = record(result)
        const integration = record(body["integration"])
        const tools = array(body["tools"])
        const slug = text(integration["slug"])
        if (asText) {
          return writeStdoutLine(
            `${slug}\t${text(integration["kind"])}\t${tools.length} tool(s)\nnext: integrations connect ${slug}`
          )
        }
        return writeStdoutLine(jsonOutput(
          withNext(
            verbose
              ? body
              : { integration, toolCount: tools.length },
            `integrations connect ${slug}`
          ),
          verbose
        ))
      }))
).pipe(Command.withDescription("Detect and register an integration"))

const searchCommand = Command.make(
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
    text: textFlag(),
    verbose: verboseFlag()
  },
  ({ query, kind, limit, text: asText, verbose }) =>
    gatewayTask((client) => {
      const parameters = new URLSearchParams({ q: query, limit: String(limit) })
      if (Option.isSome(kind)) parameters.set("kind", kind.value)
      return client.request("GET", `/v1/registry/search?${parameters.toString()}`)
    }).pipe(Effect.flatMap((result) => {
      const body = record(result)
      const results = array(body["results"])
      const shown = visibleItems(results, verbose)
      const hint = moreHint(shown.length, results.length)
      if (asText) {
        const lines = shown.map((entry) =>
          `${text(entry["name"])}\t${text(entry["kind"])}\t${text(entry["url"])}`
        )
        if (hint !== undefined) lines.push(hint)
        return writeStdoutLine(lines.join("\n") || "No matching integrations.")
      }
      return writeStdoutLine(jsonOutput(
        withNext({ ...body, results: shown }, "integrations discover <url>"),
        verbose
      ))
    }))
).pipe(Command.withDescription("Search integrations.sh for exact integration URLs"))

const listCommand = Command.make(
  "list",
  { text: textFlag(), verbose: verboseFlag() },
  ({ text: asText, verbose }) =>
    gatewayTask((client) => client.request("GET", "/v1/integrations")).pipe(
      Effect.flatMap((result) => {
        const integrations = array(record(result)["integrations"])
        const shown = visibleItems(integrations, verbose)
        const hint = moreHint(shown.length, integrations.length)
        if (asText) {
          const lines = shown.map((integration) =>
            `${text(integration["slug"])}\t${text(integration["kind"])}\t${text(integration["name"])}`
          )
          if (hint !== undefined) lines.push(hint)
          return writeStdoutLine(lines.join("\n") || "No integrations discovered.")
        }
        return writeStdoutLine(jsonOutput(
          withNext(
            {
              integrations: shown.map((integration) =>
                verbose ? integration : {
                  slug: integration["slug"],
                  kind: integration["kind"],
                  name: integration["name"],
                  connections: array(integration["connections"]).length
                }
              ),
              ...(hint === undefined ? {} : { showing: shown.length, total: integrations.length })
            },
            "integrations tools <integration>"
          ),
          verbose
        ))
      })
    )
).pipe(Command.withDescription("List the gateway's persisted integration catalog"))

const toolsCommand = Command.make(
  "tools",
  {
    integration: Argument.string("integration"),
    search: Flag.string("search").pipe(
      Flag.optional,
      Flag.withDescription("Only list tools whose name or description contains this text")
    ),
    text: textFlag(),
    verbose: verboseFlag()
  },
  ({ integration, search, text: asText, verbose }) =>
    gatewayTask((client) =>
      client.request("GET", `/v1/integrations/${encodeURIComponent(integration)}/tools`)
    ).pipe(Effect.flatMap((result) => {
      const term = Option.getOrUndefined(search)?.toLowerCase()
      const all = array(record(result)["tools"])
      const matching = term === undefined
        ? all
        : all.filter((tool) =>
          text(tool["name"]).toLowerCase().includes(term) ||
          text(tool["description"]).toLowerCase().includes(term)
        )
      const shown = visibleItems(matching, verbose)
      const hint = moreHint(shown.length, matching.length)
      if (asText) {
        const lines = shown.map((tool) =>
          `${text(tool["name"])}\t${inline(text(tool["description"]), 120)}${
            verbose ? `\t${text(tool["address"])}` : ""
          }`
        )
        if (hint !== undefined) lines.push(hint)
        return writeStdoutLine(
          lines.join("\n") ||
            (term === undefined ? "No tools available." : `No tools match "${term}".`)
        )
      }
      return writeStdoutLine(jsonOutput(
        withNext(
          {
            integration,
            tools: shown.map((tool) =>
              verbose ? tool : { name: tool["name"], description: inline(text(tool["description"]), 200) }
            ),
            ...(hint === undefined ? {} : { showing: shown.length, total: matching.length })
          },
          `integrations schema ${integration} <tool>`
        ),
        verbose
      ))
    }))
).pipe(Command.withDescription("List tool names and descriptions for an integration"))

const schemaCommand = Command.make(
  "schema",
  {
    integration: Argument.string("integration"),
    tool: Argument.string("tool"),
    connection: connectionFlag(),
    text: textFlag(),
    verbose: verboseFlag()
  },
  ({ integration, tool, connection, text: asText, verbose }) =>
    gatewayTask((client) =>
      client.request(
        "GET",
        `/v1/integrations/${encodeURIComponent(integration)}/tools/${encodeURIComponent(tool)}?connection=${
          encodeURIComponent(connection)
        }`
      )
    ).pipe(Effect.flatMap((result) => {
      const detail = record(result)
      const input = JSON.stringify(detail["inputSchema"] ?? {})
      const output = JSON.stringify(detail["outputSchema"] ?? {})
      if (asText) {
        return writeStdoutLine([
          `${text(detail["name"])}\t${text(detail["address"])}`,
          inline(text(detail["description"]), 400),
          `input: ${truncate(input, verbose)}`,
          `output: ${truncate(output, verbose)}`,
          ...(verbose ? [] : ["details: rerun with --verbose for complete schemas"])
        ].join("\n"))
      }
      return writeStdoutLine(jsonOutput(
        verbose ? detail : withNext({
          address: detail["address"],
          name: detail["name"],
          description: inline(text(detail["description"]), 400),
          input: truncate(input, false),
          output: truncate(output, false)
        }, "integrations invoke <tool-address> '<json>'"),
        verbose
      ))
    }))
).pipe(Command.withDescription("Show one tool's description and input/output schemas"))

// --- connections ------------------------------------------------------------

const environmentValue = (name: string): string => {
  const value = process.env[name]
  if (value === undefined) throw cliError(`Environment variable ${name} is not set`)
  return value
}

const credentialValues = (
  credentialEnv: string | undefined,
  credentialValuesFlag: string | undefined
): Record<string, string> => {
  if (credentialValuesFlag !== undefined) {
    return Object.fromEntries(credentialValuesFlag.split(",").map((pair) => {
      const [variable, name] = pair.split("=")
      if (variable === undefined || name === undefined) {
        throw cliError(`--credential-values expects VARIABLE=ENV_NAME pairs, got "${pair}"`)
      }
      return [variable.trim(), environmentValue(name.trim())]
    }))
  }
  // Credentials are read from the caller's environment here, never by the
  // gateway — the gateway has no business reading a client's process.
  return credentialEnv === undefined ? {} : { token: environmentValue(credentialEnv) }
}

const connectCommand = Command.make(
  "connect",
  {
    integration: Argument.string("integration"),
    connection: connectionFlag(),
    template: Flag.string("template").pipe(Flag.optional),
    credentialEnv: Flag.string("credential-env").pipe(
      Flag.optional,
      Flag.withDescription("Environment variable containing an API key or bearer token")
    ),
    credentialValues: Flag.string("credential-values").pipe(
      Flag.optional,
      Flag.withDescription("Comma-separated VARIABLE=ENV_NAME mappings for multi-value auth")
    ),
    clientId: Flag.string("client-id").pipe(Flag.optional),
    clientSecretEnv: Flag.string("client-secret-env").pipe(Flag.optional),
    noOpen: Flag.boolean("no-open"),
    timeout: Flag.integer("timeout").pipe(Flag.withDefault(300)),
    text: textFlag(),
    verbose: verboseFlag()
  },
  (options) =>
    gatewayTask(async (client) => {
      const catalog = record(
        await client.request("GET", "/v1/integrations")
      )
      const integration = array(catalog["integrations"]).find((candidate) =>
        text(candidate["slug"]) === options.integration
      )
      if (integration === undefined) {
        throw cliError(
          `Unknown integration ${options.integration}. Run: integrations discover <url>`
        )
      }
      const methods = array(integration["authMethods"])
      const template = Option.getOrUndefined(options.template)
      const oauthMethod = methods.find((method) =>
        text(method["kind"]) === "oauth" &&
        (template === undefined || text(method["template"]) === template)
      )

      if (oauthMethod !== undefined) {
        const secretName = Option.getOrUndefined(options.clientSecretEnv)
        const started = record(await client.request("POST", "/v1/connections/oauth", {
          integration: options.integration,
          connection: options.connection,
          ...(template === undefined ? {} : { template }),
          ...Option.match(options.clientId, {
            onNone: () => ({}),
            onSome: (value) => ({ clientId: value })
          }),
          ...(secretName === undefined ? {} : { clientSecret: environmentValue(secretName) }),
          timeoutSeconds: options.timeout
        }))
        const sessionId = text(started["id"])
        const state = record(started["state"])
        const authorizationUrl = text(state["authorizationUrl"])
        if (text(state["status"]) === "pending" && authorizationUrl.length > 0) {
          console.error(`Authorize in your browser:\n${authorizationUrl}`)
          if (!options.noOpen) openBrowser(authorizationUrl)
        }
        // Poll rather than block on a socket: the gateway owns the flow, and a
        // human may take minutes.
        const deadline = Date.now() + Math.max(1, options.timeout) * 1000
        while (Date.now() < deadline) {
          const session = record(await client.request("GET", `/v1/connections/oauth/${sessionId}`))
          const current = record(session["state"])
          if (text(current["status"]) === "connected") return record(current["connection"])
          if (text(current["status"]) === "failed") {
            throw cliError(`Connection failed: ${text(current["message"])}`)
          }
          await Bun.sleep(500)
        }
        throw cliError(`OAuth authorization timed out after ${options.timeout} seconds`)
      }

      const values = credentialValues(
        Option.getOrUndefined(options.credentialEnv),
        Option.getOrUndefined(options.credentialValues)
      )
      const result = record(await client.request("POST", "/v1/connections", {
        integration: options.integration,
        connection: options.connection,
        ...(template === undefined ? {} : { template }),
        values
      }))
      return result
    }).pipe(Effect.flatMap((result) => {
      const connection = record(result["connection"] ?? result)
      const tools = array(result["tools"])
      if (options.text) {
        return writeStdoutLine(
          `Connected ${text(connection["integration"])}/${text(connection["name"])}\t${tools.length} tool(s)`
        )
      }
      return writeStdoutLine(jsonOutput(
        withNext(
          options.verbose
            ? { connection, tools }
            : { connection, toolCount: tools.length },
          `integrations tools ${text(connection["integration"])}`
        ),
        options.verbose
      ))
    }))
).pipe(Command.withDescription("Authorize an integration"))

const connectionsCommand = Command.make(
  "connections",
  { text: textFlag(), verbose: verboseFlag() },
  ({ text: asText, verbose }) =>
    gatewayTask((client) => client.request("GET", "/v1/connections")).pipe(
      Effect.flatMap((result) => {
        const connections = array(record(result)["connections"])
        const shown = visibleItems(connections, verbose)
        const hint = moreHint(shown.length, connections.length)
        if (asText) {
          const lines = shown.map((connection) =>
            `${text(connection["integration"])}\t${text(connection["name"])}\t${text(connection["template"])}`
          )
          if (hint !== undefined) lines.push(hint)
          return writeStdoutLine(lines.join("\n") || "No connected integrations.")
        }
        return writeStdoutLine(jsonOutput({ connections: shown }, verbose))
      })
    )
).pipe(Command.withDescription("List connections without exposing credentials"))

const disconnectCommand = Command.make(
  "disconnect",
  { integration: Argument.string("integration"), connection: connectionFlag(), text: textFlag() },
  ({ integration, connection, text: asText }) =>
    gatewayTask((client) =>
      client.request(
        "DELETE",
        `/v1/connections/${encodeURIComponent(integration)}/${encodeURIComponent(connection)}`
      )
    ).pipe(Effect.flatMap(() =>
      writeStdoutLine(
        asText
          ? `Disconnected ${integration}/${connection}`
          : jsonOutput({ disconnected: true, integration, connection }, false)
      )
    ))
).pipe(Command.withDescription("Delete a connection"))

// --- invocation -------------------------------------------------------------

const invokeCommand = Command.make(
  "invoke",
  {
    address: Argument.string("tool-address"),
    input: Argument.string("json").pipe(Argument.optional),
    file: Flag.string("file").pipe(
      Flag.optional,
      Flag.withDescription("Read the JSON input from a file")
    ),
    verbose: verboseFlag()
  },
  ({ address, input, file, verbose }) =>
    gatewayTask(async (client) => {
      const payload = await readJsonArgument(
        Option.getOrUndefined(input),
        Option.getOrUndefined(file)
      )
      return await client.request("POST", "/v1/tools/invoke", { address, arguments: payload })
    }).pipe(Effect.flatMap((result) =>
      writeStdoutLine(truncate(jsonOutput(result, verbose), verbose))
    ))
).pipe(
  Command.withDescription(
    "Invoke a tool by address. Privileged: for testing a connection, not for delegated use"
  )
)

const executeCommand = Command.make(
  "execute",
  {
    alias: Argument.string("alias"),
    tool: Argument.string("tool"),
    input: Argument.string("json").pipe(Argument.optional),
    file: Flag.string("file").pipe(Flag.optional),
    verbose: verboseFlag()
  },
  ({ alias, tool, input, file, verbose }) =>
    gatewayTask(async (client) => {
      const payload = await readJsonArgument(
        Option.getOrUndefined(input),
        Option.getOrUndefined(file)
      )
      return await client.execute({
        alias,
        tool,
        arguments: Schema.decodeUnknownSync(Schema.Json)(payload)
      })
    }).pipe(Effect.flatMap((outcome) =>
      writeStdoutLine(truncate(jsonOutput(outcome, verbose), verbose))
    ))
).pipe(
  Command.withDescription("Invoke a granted tool through an alias, as a delegated caller would")
)

const validateCommand = Command.make(
  "validate",
  {
    config: Argument.string("json-or-tool-address").pipe(Argument.optional),
    file: Flag.string("file").pipe(Flag.optional),
    live: Flag.boolean("live"),
    text: textFlag()
  },
  ({ config, file, live, text: asText }) =>
    gatewayTask(async (client) => {
      const configText = Option.getOrUndefined(config)
      const filePath = Option.getOrUndefined(file)
      if ((configText === undefined) === (filePath === undefined)) {
        throw cliError("Provide exactly one of a JSON config or --file")
      }
      const directAddress = configText?.startsWith("tools.") === true
      const source = filePath === undefined
        ? directAddress
          ? JSON.stringify({ source: { kind: "executor", address: configText } })
          : configText ?? "{}"
        : await Bun.file(filePath).text()
      return {
        directAddress,
        report: record(await client.request("POST", "/v1/validate", {
          node: JSON.parse(source),
          live: live || directAddress
        }))
      }
    }).pipe(Effect.flatMap(({ report }) => {
      const findings = array(report["findings"])
      const rendered = asText
        ? findings.map((finding) =>
          `${text(finding["severity"])}\t${text(finding["check"])}\t${text(finding["message"])}`
        ).join("\n")
        : jsonOutput(report, false)
      return writeStdoutLine(rendered).pipe(
        Effect.flatMap(() =>
          report["ok"] === true
            ? Effect.void
            : Effect.fail(cliError("Integration validation failed"))
        )
      )
    }))
).pipe(Command.withDescription("Validate a tool address or integration node config"))

// --- delegation -------------------------------------------------------------

const clientsCommand = Command.make(
  "clients",
  { text: textFlag(), verbose: verboseFlag() },
  ({ text: asText, verbose }) =>
    gatewayTask((client) => client.request("GET", "/v1/clients")).pipe(
      Effect.flatMap((result) => {
        const clients = array(record(result)["clients"])
        const shown = visibleItems(clients, verbose)
        const hint = moreHint(shown.length, clients.length)
        if (asText) {
          const lines = shown.map((entry) =>
            `${text(entry["name"])}\t${entry["mayMutate"] === true ? "may-mutate" : "delegated"}\t${
              entry["revokedAt"] === null ? "live" : "revoked"
            }\t${text(entry["id"])}`
          )
          if (hint !== undefined) lines.push(hint)
          return writeStdoutLine(lines.join("\n") || "No clients.")
        }
        return writeStdoutLine(jsonOutput({ clients: shown }, verbose))
      })
    )
).pipe(Command.withDescription("List clients that may hold grants"))

const clientCommand = Command.make(
  "client",
  {
    name: Argument.string("name"),
    mayMutate: Flag.boolean("may-mutate").pipe(
      Flag.withDescription("Allow this client to change the catalog, connections, and grants")
    ),
    text: textFlag()
  },
  ({ name, mayMutate, text: asText }) =>
    gatewayTask((client) => client.request("POST", "/v1/clients", { name, mayMutate })).pipe(
      Effect.flatMap((result) => {
        const created = record(result)
        return writeStdoutLine(
          asText
            ? `Created client ${text(created["name"])}\t${text(created["id"])}`
            : jsonOutput(
              withNext(created, `integrations key ${text(created["id"])}`),
              false
            )
        )
      })
    )
).pipe(Command.withDescription("Create a client that grants can be issued to"))

const keyCommand = Command.make(
  "key",
  { clientId: Argument.string("client-id"), text: textFlag() },
  ({ clientId, text: asText }) =>
    gatewayTask((client) =>
      client.request("POST", `/v1/clients/${encodeURIComponent(clientId)}/keys`, {})
    ).pipe(Effect.flatMap((result) => {
      const issued = record(result)
      // Shown once. Nothing stores the plaintext, so a lost key is reissued
      // rather than recovered.
      return writeStdoutLine(
        asText
          ? `${text(issued["secret"])}\n(shown once — the gateway stores only a hash)`
          : jsonOutput(issued, false)
      )
    }))
).pipe(Command.withDescription("Issue an API key for a client. Shown once"))

const grantCommand = Command.make(
  "grant",
  {
    clientId: Argument.string("client-id"),
    alias: Argument.string("alias"),
    tool: Argument.string("tool"),
    integration: Flag.string("integration").pipe(
      Flag.withDescription("Integration slug the alias resolves to")
    ),
    connection: connectionFlag(),
    owner: Flag.choice("owner", ["org", "user"]).pipe(Flag.withDefault("org" as const)),
    subject: Flag.string("subject").pipe(
      Flag.optional,
      Flag.withDescription("Required for a user-tier connection: the human it belongs to")
    ),
    requireApproval: Flag.boolean("require-approval").pipe(
      Flag.withDescription("Freeze this tool's calls for a human instead of running them")
    ),
    text: textFlag()
  },
  (options) =>
    gatewayTask((client) => {
      const subject = Option.getOrUndefined(options.subject)
      if (options.owner === "user" && subject === undefined) {
        throw cliError("--subject is required for a user-tier connection")
      }
      return client.request("POST", "/v1/grants", {
        clientId: options.clientId,
        alias: options.alias,
        tool: options.tool,
        connection: options.owner === "org"
          ? { owner: "org", integration: options.integration, name: options.connection }
          : {
            owner: "user",
            subject,
            integration: options.integration,
            name: options.connection
          },
        decision: options.requireApproval ? "require_approval" : "allow"
      })
    }).pipe(Effect.flatMap((result) => {
      const grant = record(result)
      return writeStdoutLine(
        options.text
          ? `Granted ${text(grant["alias"])}.${text(grant["tool"])}\t${text(grant["decision"])}`
          : jsonOutput(grant, false)
      )
    }))
).pipe(Command.withDescription("Delegate one tool through one connection to one client"))

const grantsCommand = Command.make(
  "grants",
  { clientId: Argument.string("client-id"), text: textFlag(), verbose: verboseFlag() },
  ({ clientId, text: asText, verbose }) =>
    gatewayTask((client) =>
      client.request("GET", `/v1/grants?clientId=${encodeURIComponent(clientId)}`)
    ).pipe(Effect.flatMap((result) => {
      const grants = array(record(result)["grants"])
      const shown = visibleItems(grants, verbose)
      const hint = moreHint(shown.length, grants.length)
      if (asText) {
        const lines = shown.map((grant) => {
          const connection = record(grant["connection"])
          return `${text(grant["alias"])}.${text(grant["tool"])}\t${text(grant["decision"])}\t${
            text(connection["owner"])
          }:${text(connection["integration"])}/${text(connection["name"])}`
        })
        if (hint !== undefined) lines.push(hint)
        return writeStdoutLine(lines.join("\n") || "No grants.")
      }
      return writeStdoutLine(jsonOutput({ grants: shown }, verbose))
    }))
).pipe(Command.withDescription("List a client's grants"))

const toolsForKeyCommand = Command.make(
  "granted",
  { text: textFlag(), verbose: verboseFlag() },
  ({ text: asText, verbose }) =>
    gatewayTask((client) => client.tools()).pipe(Effect.flatMap((tools) => {
      const shown = visibleItems(tools, verbose)
      const hint = moreHint(shown.length, tools.length)
      if (asText) {
        const lines = shown.map((tool) => `${tool.alias}.${tool.tool}\t${tool.decision}`)
        if (hint !== undefined) lines.push(hint)
        return writeStdoutLine(lines.join("\n") || "No granted tools.")
      }
      return writeStdoutLine(jsonOutput({ tools: shown }, verbose))
    }))
).pipe(Command.withDescription("List the tools this key can reach"))

// --- approvals and audit ----------------------------------------------------

const approvalsCommand = Command.make(
  "approvals",
  {
    status: Flag.choice("status", ["pending", "approved", "denied", "expired"]).pipe(Flag.optional),
    text: textFlag(),
    verbose: verboseFlag()
  },
  ({ status, text: asText, verbose }) =>
    gatewayTask((client) =>
      client.request(
        "GET",
        Option.isNone(status) ? "/v1/approvals" : `/v1/approvals?status=${status.value}`
      )
    ).pipe(Effect.flatMap((result) => {
      const approvals = array(record(result)["approvals"])
      const shown = visibleItems(approvals, verbose)
      const hint = moreHint(shown.length, approvals.length)
      if (asText) {
        const lines = shown.map((approval) =>
          `${text(approval["id"])}\t${text(approval["status"])}\t${text(approval["alias"])}.${
            text(approval["tool"])
          }`
        )
        if (hint !== undefined) lines.push(hint)
        return writeStdoutLine(lines.join("\n") || "No approvals.")
      }
      return writeStdoutLine(jsonOutput(
        withNext({ approvals: shown }, "integrations approve <id>"),
        verbose
      ))
    }))
).pipe(Command.withDescription("List frozen invocations awaiting a decision"))

const approveCommand = Command.make(
  "approve",
  {
    id: Argument.string("approval-id"),
    by: Flag.string("by").pipe(Flag.optional, Flag.withDescription("Record who approved")),
    text: textFlag()
  },
  ({ id, by, text: asText }) =>
    gatewayTask((client) =>
      client.request("POST", `/v1/approvals/${encodeURIComponent(id)}/approve`, {
        ...Option.match(by, { onNone: () => ({}), onSome: (value) => ({ decidedBy: value }) })
      })
    ).pipe(Effect.flatMap((result) => {
      const body = record(result)
      const outcome = record(body["outcome"])
      // The gateway performed the call. Approving discharged one frozen
      // invocation; it did not hand anyone a capability.
      return writeStdoutLine(
        asText ? `Approved ${id}\t${text(outcome["status"])}` : jsonOutput(body, false)
      )
    }))
).pipe(Command.withDescription("Approve a frozen invocation; the gateway then performs it"))

const denyCommand = Command.make(
  "deny",
  {
    id: Argument.string("approval-id"),
    by: Flag.string("by").pipe(Flag.optional),
    text: textFlag()
  },
  ({ id, by, text: asText }) =>
    gatewayTask((client) =>
      client.request("POST", `/v1/approvals/${encodeURIComponent(id)}/deny`, {
        ...Option.match(by, { onNone: () => ({}), onSome: (value) => ({ decidedBy: value }) })
      })
    ).pipe(Effect.flatMap((result) =>
      writeStdoutLine(asText ? `Denied ${id}` : jsonOutput(record(result), false))
    ))
).pipe(Command.withDescription("Deny a frozen invocation"))

const auditCommand = Command.make(
  "audit",
  {
    limit: Flag.integer("limit").pipe(Flag.withDefault(20)),
    text: textFlag(),
    verbose: verboseFlag()
  },
  ({ limit, text: asText, verbose }) =>
    gatewayTask((client) => client.request("GET", `/v1/audit?limit=${limit}`)).pipe(
      Effect.flatMap((result) => {
        const records = array(record(result)["records"])
        const shown = visibleItems(records, verbose, limit)
        if (asText) {
          return writeStdoutLine(
            shown.map((entry) =>
              `${text(entry["createdAt"])}\t${text(entry["outcome"])}\t${text(entry["alias"])}.${
                text(entry["tool"])
              }\t${text(entry["subject"])}`
            ).join("\n") || "No audit records."
          )
        }
        return writeStdoutLine(jsonOutput({ records: shown }, verbose))
      })
    )
).pipe(Command.withDescription("Read the gateway's audit trail"))

const driftCommand = Command.make(
  "drift",
  {
    integration: Argument.string("integration").pipe(Argument.optional),
    text: textFlag(),
    verbose: verboseFlag()
  },
  ({ integration, text: asText, verbose }) =>
    gatewayTask((client) =>
      client.request(
        "POST",
        Option.isNone(integration)
          ? "/v1/drift/refresh"
          : `/v1/drift/refresh?integration=${encodeURIComponent(integration.value)}`
      )
    ).pipe(Effect.flatMap((result) => {
      const reports = array(record(result)["reports"])
      const entries: ReadonlyArray<Record<string, unknown>> = reports.flatMap((report) =>
        array(report["entries"]).map((entry) => ({
          ...entry,
          integration: report["integration"]
        }))
      )
      const shown = visibleItems(entries, verbose)
      const hint = moreHint(shown.length, entries.length)
      if (asText) {
        const lines = shown.map((entry) =>
          `${text(entry["kind"])}\t${text(entry["integration"])}.${text(entry["tool"])}`
        )
        if (hint !== undefined) lines.push(hint)
        return writeStdoutLine(lines.join("\n") || "No drift since the last refresh.")
      }
      return writeStdoutLine(jsonOutput({ drift: shown, checked: reports.length }, verbose))
    }))
).pipe(
  Command.withDescription(
    "Re-read tools and report what a vendor added, removed, or reshaped since the last sync"
  )
)

const codegenCommand = Command.make(
  "codegen",
  {
    target: Flag.choice("target", ["effect", "ts"]).pipe(
      Flag.withDefault("effect" as const),
      Flag.withDescription(
        "effect: Effect Schema plus integration() steps for wf. ts: typed calls over the client"
      )
    ),
    out: Flag.string("out").pipe(
      Flag.optional,
      Flag.withDescription("Write to a file instead of stdout")
    )
  },
  ({ target, out }) =>
    gatewayTask(async (client) => {
      // Generated from this key's grants, so the generated surface is the
      // authorized surface. Adding a tool here means adding a grant.
      const tools = await client.tools({ schemas: true })
      if (tools.length === 0) {
        throw cliError(
          "This key holds no grants, so there is nothing to generate. Run: integrations grant <client-id> <alias> <tool> --integration <slug>"
        )
      }
      const module_ = generateModule(target as CodegenTarget, tools, client.url)
      const destination = Option.getOrUndefined(out)
      if (destination !== undefined) {
        await Bun.write(destination, module_)
        return { written: destination, tools: tools.length }
      }
      return { module: module_, tools: tools.length }
    }).pipe(Effect.flatMap((result) =>
      typeof result.module === "string"
        ? writeStdoutLine(result.module)
        : writeStdoutLine(
          `Wrote ${text(result.written)} (${result.tools} tool(s))`
        )
    ))
).pipe(
  Command.withDescription(
    "Generate typed bindings for the tools this key can reach"
  )
)

export const integrationsSubcommands = [
  discoverCommand,
  searchCommand,
  listCommand,
  toolsCommand,
  schemaCommand,
  connectCommand,
  connectionsCommand,
  disconnectCommand,
  invokeCommand,
  executeCommand,
  validateCommand,
  clientsCommand,
  clientCommand,
  keyCommand,
  grantCommand,
  grantsCommand,
  toolsForKeyCommand,
  approvalsCommand,
  approveCommand,
  denyCommand,
  auditCommand,
  driftCommand,
  codegenCommand
] as const
