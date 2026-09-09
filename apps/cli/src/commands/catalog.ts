import { whenPresent } from "@integrations/contracts"
import type { GatewayClient } from "@mokronos/integrations-client"
import type { HttpClient } from "effect/unstable/http"
import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { PositiveInt } from "@integrations/contracts"
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

const gatewayTask = <A, E, R>(
  task: (client: GatewayClient) => Effect.Effect<A, E, R>
): Effect.Effect<A, IntegrationsCliError, R | HttpClient.HttpClient> =>
  connectToGateway().pipe(
    Effect.flatMap(task),
    Effect.mapError((error) => cliError(describeError(error)))
  )

type GatewayTask = typeof gatewayTask

const JsonObject = Schema.Record(Schema.String, Schema.Json)
const JsonArray = Schema.Array(Schema.Json)

const record = <A>(value: A | undefined): Record<string, typeof Schema.Json.Type> =>
  Option.getOrElse(Schema.decodeUnknownOption(JsonObject)(value), () => ({}))

const array = <A>(value: A | undefined): ReadonlyArray<Record<string, typeof Schema.Json.Type>> =>
  Option.getOrElse(Schema.decodeUnknownOption(JsonArray)(value), () => []).map(record)

const text = (value: Schema.Json | undefined): string => value === undefined || value === null ? "" : String(value)

const sortedBy = <A>(
  items: ReadonlyArray<A>,
  key: (item: A) => string
): ReadonlyArray<A> => [...items].sort((left, right) => key(left).localeCompare(key(right)))

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

export const discoverCommand = (runGateway: GatewayTask) => Command.make(
  "discover",
  {
    url: Argument.string("url").pipe(
      Argument.withDescription("MCP endpoint or OpenAPI document URL")
    ),
    connection: connectionFlag(),
    slug: Flag.string("slug").pipe(
      Flag.optional,
      Flag.withDescription("Address it as this instead of a name derived from the URL")
    ),
    name: Flag.string("name").pipe(
      Flag.optional,
      Flag.withDescription("Show it under this name instead of the derived one")
    ),
    verbose: verboseFlag()
  },
  ({ url, connection, slug: chosenSlug, name, verbose }) =>
    runGateway((client) =>
      client.provisioning.discover({ payload: {
        url,
        connection,
        ...whenPresent("slug", Option.getOrUndefined(chosenSlug)),
        ...whenPresent("name", Option.getOrUndefined(name))
      } }))
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
      Flag.withDescription("How many results to ask the registry for (default: 5)")
    ),
    verbose: verboseFlag()
  },
  ({ query, kind, limit, verbose }) =>
    runGateway((client) => client.provisioning.registrySearch({ query: {
      q: query,
      limit: PositiveInt.make(limit),
      ...whenPresent("kind", Option.getOrUndefined(kind))
    } })).pipe(Effect.flatMap((result) => {
      const body = record(result)
      const results = array(body["results"])
      return writeStdoutLine(jsonOutput(
        withNext({ ...body, count: results.length }, "i discover <url>"),
        verbose
      ))
    }))
).pipe(Command.withDescription("Search integrations.sh for exact integration URLs"))

export const renameCommand = (runGateway: GatewayTask) => Command.make(
  "rename",
  {
    integration: Argument.string("integration").pipe(
      Argument.withDescription("Integration slug")
    ),
    name: Argument.string("name").pipe(
      Argument.withDescription("What to show it as from now on")
    ),
    verbose: verboseFlag()
  },
  ({ integration, name, verbose }) =>
    runGateway((client) =>
      client.provisioning.renameIntegration({ params: { slug: integration }, payload: { name } })).pipe(
      Effect.flatMap((result) =>
        writeStdoutLine(jsonOutput(record(result), verbose))
      )
    )
).pipe(Command.withDescription(
  "Change an integration's display name. Its slug does not change"
))

export const integrationsCommand = (runGateway: GatewayTask) => Command.make(
  "integrations",
  {
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ limit, offset, verbose }) =>
    runGateway((client) => client.provisioning.listIntegrations()).pipe(
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
              connections: array(integration["connections"])
                .filter((connection) => text(connection["status"]) === "connected").length,
              reauthorizationRequired: array(integration["connections"])
                .filter((connection) => text(connection["status"]) === "reauthorization_required").length
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
    runGateway((client) => client.provisioning.integrationTools({ params: { slug: integration } })).pipe(Effect.flatMap((result) => {
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
    runGateway((client) =>
      Effect.all({
        detail: client.provisioning.describeTool({
          params: { slug: integration, tool },
          query: { connection }
        }),
        effective: client.delegated.listTools({ query: { schemas: false } })
      })).pipe(Effect.flatMap(({ detail: found, effective }) => {
      const detail = record(found)
      const core = Object.fromEntries(
        Object.entries(detail).filter(([key]) =>
          key !== "inputTypeScript" && key !== "outputTypeScript"
        )
      )
      const callable = effective.tools.find((candidate) =>
        candidate.tool === tool &&
        candidate.connection.integration === integration &&
        candidate.connection.name === connection
      )
      return writeStdoutLine(jsonOutput(
        withNext(
          { ...(verbose ? detail : core), alias: callable?.alias ?? null },
          callable === undefined
            ? `i connect ${integration}`
            : `i execute ${callable.alias} ${tool} '<json>'`
        ),
        verbose
      ))
    }))
).pipe(Command.withDescription("Show one tool's description and input/output schemas"))
