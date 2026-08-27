import { whenPresent, whenPresentMap } from "@mokronos/contracts"
import type { GatewayClient } from "@mokronos/integrations-client"
import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import type { IntegrationsCliError } from "../connection.ts"
import { cliError, connectToGateway, describeError, openBrowser } from "../connection.ts"
import type { Page, Window } from "../output.ts"
import {
  jsonOutput,
  page,
  pageFields,
  withNext,
  writeStdoutLine
} from "../output.ts"

const verboseFlag = () =>
  Flag.boolean("verbose").pipe(
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

export const connectCommand = (runGateway: GatewayTask) => Command.make(
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
    verbose: verboseFlag()
  },
  (options) =>
    runGateway(async (client) => {
      const catalog = record(await client.integrations())
      const integration = array(catalog["integrations"]).find((candidate) =>
        text(candidate["slug"]) === options.integration
      )
      if (integration === undefined) {
        throw cliError(
          `Unknown integration ${options.integration}. Run: i discover <url>`
        )
      }
      const methods = array(integration["authMethods"])
      const template = Option.getOrUndefined(options.template)
      const credentialsOffered = Option.isSome(options.credentialEnv) ||
        Option.isSome(options.credentialValues)
      const oauthMethod = methods.find((method) =>
        text(method["kind"]) === "oauth" &&
        (template === undefined || text(method["template"]) === template)
      )

      if (oauthMethod !== undefined && credentialsOffered && template === undefined) {
        // Silently ignoring the credential and opening a browser is the worst
        // of both: the caller thinks it authorized with the key it named.
        const alternatives = methods.filter((method) => text(method["kind"]) !== "oauth")
        throw cliError(
          alternatives.length === 0
            ? `${options.integration} only supports OAuth, so --credential-env cannot be used. Drop it and authorize in a browser.`
            : `${options.integration} supports OAuth and ${alternatives.map((method) => text(method["template"])).join(", ")
            }. Name the one you mean with --template.`
        )
      }

      if (oauthMethod !== undefined) {
        const secretName = Option.getOrUndefined(options.clientSecretEnv)
        const started = record(await client.startOAuth({
          integration: options.integration,
          connection: options.connection,
          ...whenPresent("template", template),
          ...Option.match(options.clientId, {
            onNone: () => ({}),
            onSome: (value) => ({ clientId: value })
          }),
          ...whenPresentMap("clientSecret", secretName, environmentValue),
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
          const session = record(await client.oauth(sessionId))
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
      return record(await client.connect({
        integration: options.integration,
        connection: options.connection,
        ...whenPresent("template", template),
        values
      }))
    }).pipe(Effect.flatMap((result) => {
      const connection = record(result["connection"] ?? result)
      const tools = array(result["tools"])
      const storedName = text(connection["name"])
      // The stored name is normalised, so say so rather than letting the next
      // command fail on the name that was typed.
      if (storedName.length > 0 && storedName !== options.connection) {
        console.error(
          `Note: connection stored as "${storedName}", not "${options.connection}". Use that name from here on.`
        )
      }
      return writeStdoutLine(jsonOutput(
        withNext(
          options.verbose ? { connection, tools } : { connection, toolCount: tools.length },
          `i tools ${text(connection["integration"])}`
        ),
        options.verbose
      ))
    }))
).pipe(Command.withDescription("Authorize an integration"))

export const connectionsCommand = (runGateway: GatewayTask) => Command.make(
  "connections",
  { limit: limitFlag(), offset: offsetFlag(), verbose: verboseFlag() },
  ({ limit, offset, verbose }) =>
    runGateway((client) => client.connections()).pipe(
      Effect.flatMap((result) => {
        const all = sortedBy(
          array(record(result)["connections"]),
          (connection) => `${text(connection["integration"])} ${text(connection["name"])}`
        )
        return listing(page(all, window(limit, offset)), {
          key: "connections",
          narrowing: "window with --limit/--offset",
          verbose,
          empty: "No connected integrations.",
          row: (connection) => connection
        })
      })
    )
).pipe(Command.withDescription("List connections without exposing credentials"))

export const disconnectCommand = (runGateway: GatewayTask) => Command.make(
  "disconnect",
  { integration: Argument.string("integration"), connection: connectionFlag() },
  ({ integration, connection }) =>
    runGateway((client) => client.disconnect({ integration, connection })).pipe(
      Effect.flatMap((result) => {
        // The gateway resolves the name it actually removed, which may differ
        // from the one typed. Report that one.
        const removed = text(record(result)["connection"] ?? connection)
        return writeStdoutLine(
          jsonOutput({ disconnected: true, integration, connection: removed }, false)
        )
      }))
).pipe(Command.withDescription("Delete a connection"))

// --- invocation -------------------------------------------------------------

/** A tool address is recognisable: an alias is lowercase letters, digits, and
 *  dashes, so it can never look like one. `--direct` states the intent
 *  explicitly and fails if the target is not an address. */
