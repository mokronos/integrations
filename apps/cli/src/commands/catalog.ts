import { whenPresent } from "@mokronos/contracts"
import type { GatewayClient } from "@mokronos/integrations-client"
import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import type { IntegrationsCliError } from "../connection.ts"
import { cliError, connectToGateway, describeError } from "../connection.ts"
import type { Page, Window } from "../output.ts"
import {
  inline,
  jsonOutput,
  page,
  pageFields,
  withNext,
  writeStdoutLine
} from "../output.ts"

const verboseFlag = () =>
  Flag.boolean("verbose").pipe(
    Flag.withDefault(false),
    Flag.withAlias("v"),
    // Says how much of each row to show. It does not say how many rows: a
    // listing returns all of them either way, so nothing is hidden behind a
    // flag the reader did not know to pass.
    Flag.withDescription("Show complete objects, pretty-printed")
  )

const limitFlag = () =>
  Flag.integer("limit").pipe(
    Flag.optional,
    Flag.withDescription("Return at most this many rows (default: all of them)")
  )

const offsetFlag = () =>
  Flag.integer("offset").pipe(
    Flag.optional,
    Flag.withDescription("Skip this many rows. Listings are ordered, so a window is stable")
  )

const connectionFlag = () =>
  Flag.string("connection").pipe(
    Flag.withDefault("default"),
    Flag.withDescription("Connection name (default: default)")
  )

const window = (
  limit: Option.Option<number>,
  offset: Option.Option<number>
): Window => ({
  limit: Option.getOrUndefined(limit),
  offset: Option.getOrUndefined(offset)
})

const gatewayTask = <A>(
  task: (client: GatewayClient) => Promise<A>
): Effect.Effect<A, IntegrationsCliError> =>
  Effect.tryPromise({
    try: async () => await task(await connectToGateway()),
    catch: (error) => cliError(describeError(error))
  })

type GatewayTask = typeof gatewayTask

const JsonObject = Schema.Record(Schema.String, Schema.Json)
const JsonArray = Schema.Array(Schema.Json)

/** The gateway's responses arrive as unparsed JSON. These decode a response into
 *  a usable value and fall back to empty rather than failing the command: a
 *  listing that renders nothing is easier for a reader to act on than a crash,
 *  and the gateway is the party responsible for its own response shape. */
const record = <A>(value: A | undefined): Record<string, typeof Schema.Json.Type> =>
  Option.getOrElse(Schema.decodeUnknownOption(JsonObject)(value), () => ({}))

const array = <A>(value: A | undefined): ReadonlyArray<Record<string, typeof Schema.Json.Type>> =>
  Option.getOrElse(Schema.decodeUnknownOption(JsonArray)(value), () => []).map(record)

const text = (value: Schema.Json | undefined): string => value === undefined || value === null ? "" : String(value)

/** Listings are ordered before they are windowed. An offset into an unordered
 *  result addresses different rows on every call, which makes paging worse than
 *  no paging. */
const sortedBy = <A>(
  items: ReadonlyArray<A>,
  key: (item: A) => string
): ReadonlyArray<A> => [...items].sort((left, right) => key(left).localeCompare(key(right)))

/** Prints a listing. Keeping this in one place is what makes `count`, the
 *  window fields, and the hint behave the same on every listing. */
const listing = <A>(
  result: Page<A>,
  options: {
    readonly key: string
    readonly narrowing: string
    readonly verbose: boolean
    readonly row: (item: A) => typeof Schema.Json.Type
    readonly empty: string
    readonly next?: string
    readonly extra?: Record<string, typeof Schema.Json.Type>
  }
): Effect.Effect<void> =>
  writeStdoutLine(jsonOutput(
    withNext({
      ...options.extra,
      [options.key]: result.items.map(options.row),
      ...pageFields(result, options.narrowing)
    }, options.next),
    options.verbose
  ))

// --- catalog ----------------------------------------------------------------

export const discoverCommand = (runGateway: GatewayTask) => Command.make(
  "discover",
  {
    url: Argument.string("url").pipe(
      Argument.withDescription("MCP endpoint or OpenAPI document URL")
    ),
    connection: connectionFlag(),
    verbose: verboseFlag()
  },
  ({ url, connection, verbose }) =>
    runGateway((client) => client.discover({ url, connection }))
      .pipe(Effect.flatMap((result) => {
        const body = record(result)
        const integration = record(body["integration"])
        const tools = array(body["tools"])
        const slug = text(integration["slug"])
        return writeStdoutLine(jsonOutput(
          withNext(
            verbose ? body : { integration, toolCount: tools.length },
            `i connect ${slug}`
          ),
          verbose
        ))
      }))
).pipe(Command.withDescription("Detect and register an integration"))

export const searchCommand = (runGateway: GatewayTask) => Command.make(
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
      // Not a window over a local listing: this one is asked of the registry,
      // which ranks by relevance. Reordering it here would throw that away.
      Flag.withDescription("How many results to ask the registry for (default: 5)")
    ),
    verbose: verboseFlag()
  },
  ({ query, kind, limit, verbose }) =>
    runGateway((client) => client.search({
      query,
      limit,
      ...whenPresent("kind", Option.getOrUndefined(kind))
    })).pipe(Effect.flatMap((result) => {
      const body = record(result)
      const results = array(body["results"])
      return writeStdoutLine(jsonOutput(
        withNext({ ...body, count: results.length }, "i discover <url>"),
        verbose
      ))
    }))
).pipe(Command.withDescription("Search integrations.sh for exact integration URLs"))

export const integrationsCommand = (runGateway: GatewayTask) => Command.make(
  "integrations",
  {
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ limit, offset, verbose }) =>
    runGateway((client) => client.integrations()).pipe(
      Effect.flatMap((result) => {
        const all = sortedBy(array(record(result)["integrations"]), (entry) => text(entry["slug"]))
        return listing(page(all, window(limit, offset)), {
          key: "integrations",
          narrowing: "window with --limit/--offset",
          verbose,
          empty: "No integrations discovered.",
          next: "i tools <integration>",
          row: (integration) =>
            verbose ? integration : {
              slug: integration["slug"] ?? null,
              kind: integration["kind"] ?? null,
              name: integration["name"] ?? null,
              connections: array(integration["connections"]).length
            }
        })
      })
    )
).pipe(Command.withDescription("List registered integrations"))

export const toolsCommand = (runGateway: GatewayTask) => Command.make(
  "tools",
  {
    integration: Argument.string("integration"),
    filter: Flag.string("filter").pipe(
      Flag.optional,
      Flag.withDescription("Only list tools whose name or description contains this text")
    ),
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ integration, filter, limit, offset, verbose }) =>
    runGateway((client) => client.integrationTools(integration)).pipe(Effect.flatMap((result) => {
      const term = Option.getOrUndefined(filter)?.toLowerCase()
      const all = array(record(result)["tools"])
      const matching = term === undefined
        ? all
        : all.filter((tool) =>
          text(tool["name"]).toLowerCase().includes(term) ||
          text(tool["description"]).toLowerCase().includes(term)
        )
      return listing(
        page(sortedBy(matching, (tool) => text(tool["name"])), window(limit, offset)),
        {
          key: "tools",
          narrowing: "narrow with --filter <text>, or window with --limit/--offset",
          verbose,
          empty: term === undefined ? "No tools available." : `No tools match "${term}".`,
          next: `i schema ${integration} <tool>`,
          extra: { integration },
          row: (tool) =>
            verbose ? tool : {
              name: tool["name"] ?? null,
              description: inline(text(tool["description"]), 200)
            }
        }
      )
    }))
).pipe(Command.withDescription("List tool names and descriptions for an integration"))

export const schemaCommand = (runGateway: GatewayTask) => Command.make(
  "schema",
  {
    integration: Argument.string("integration"),
    tool: Argument.string("tool"),
    connection: connectionFlag(),
    verbose: verboseFlag()
  },
  ({ integration, tool, connection, verbose }) =>
    runGateway((client) => client.integrationTool({
      integration,
      tool,
      connection
    })).pipe(Effect.flatMap((result) => {
      const detail = record(result)
      // Schemas stay objects, whole, at both verbosities. They are the reason
      // to run this command, and a schema handed back as a truncated string
      // has to be re-fetched before it can be used for anything.
      const core = Object.fromEntries(
        Object.entries(detail).filter(([key]) =>
          key !== "inputTypeScript" && key !== "outputTypeScript"
        )
      )
      return writeStdoutLine(jsonOutput(
        withNext(
          verbose ? detail : core,
          `i execute ${integration.replace(/[^a-z0-9]+/g, "-")} ${tool} '<json>'`
        ),
        verbose
      ))
    }))
).pipe(Command.withDescription("Show one tool's description and input/output schemas"))

// --- connections ------------------------------------------------------------
