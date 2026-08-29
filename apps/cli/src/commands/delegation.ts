import { whenPresent } from "@mokronos/contracts"
import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import type { IntegrationsCliError } from "../connection.ts"
import { cliError, describeError } from "../connection.ts"
import type { Page, Window } from "../output.ts"
import {
  jsonOutput,
  page,
  pageFields,
  withNext,
  writeStdoutLine
} from "../output.ts"
import type { ControlPlaneClient } from "../session.ts"
import { connectToControlPlane } from "../session.ts"

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

const controlPlaneTask = <A>(
  task: (client: ControlPlaneClient) => Promise<A>
): Effect.Effect<A, IntegrationsCliError> =>
  Effect.tryPromise({
    try: async () => await task(await connectToControlPlane()),
    catch: (error) => cliError(describeError(error))
  })

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

export const clientsCommand = Command.make(
  "clients",
  { limit: limitFlag(), offset: offsetFlag(), verbose: verboseFlag() },
  ({ limit, offset, verbose }) =>
    controlPlaneTask((client) => client.request("GET", "/v1/clients")).pipe(
      Effect.flatMap((result) => {
        const all = sortedBy(array(record(result)["clients"]), (entry) => text(entry["name"]))
        return listing(page(all, window(limit, offset)), {
          key: "clients",
          narrowing: "window with --limit/--offset",
          verbose,
          empty: "No clients.",
          row: (entry) => entry
        })
      })
    )
).pipe(Command.withDescription("List clients that may hold grants"))

export const clientCommand = Command.make(
  "client",
  {
    name: Argument.string("name"),
    provision: Flag.boolean("provision").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Allow this client to discover and connect integrations")
    ),
    administer: Flag.boolean("administer").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Allow this client to administer clients, keys, grants, audit, and policy")
    )
  },
  ({ name, provision, administer }) =>
    controlPlaneTask((client) => client.request("POST", "/v1/clients", {
      name,
      capabilities: [
        ...(provision ? ["provision_connections"] : []),
        ...(administer ? ["administer_gateway"] : [])
      ]
    })).pipe(
      Effect.flatMap((result) => {
        const created = record(result)
        return writeStdoutLine(jsonOutput(
          withNext(created, `ii key ${text(created["id"])}`),
          false
        ))
      })
    )
).pipe(Command.withDescription("Create a client that grants can be issued to"))

export const keyCommand = Command.make(
  "key",
  { clientId: Argument.string("client-id") },
  ({ clientId }) =>
    controlPlaneTask((client) =>
      client.request("POST", `/v1/clients/${encodeURIComponent(clientId)}/keys`, {})
    ).pipe(Effect.flatMap((result) => {
      const issued = record(result)
      // Shown once. Nothing stores the plaintext, so a lost key is reissued
      // rather than recovered.
      return writeStdoutLine(jsonOutput(issued, false))
    }))
).pipe(Command.withDescription("Issue an API key for a client. Shown once"))

export const keysCommand = Command.make(
  "keys",
  {
    clientId: Argument.string("client-id"),
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ clientId, limit, offset, verbose }) =>
    controlPlaneTask((client) =>
      client.request("GET", `/v1/clients/${encodeURIComponent(clientId)}/keys`)
    ).pipe(Effect.flatMap((result) => {
      const all = sortedBy(array(record(result)["keys"]), (key) => text(key["createdAt"]))
      return listing(page(all, window(limit, offset)), {
        key: "keys",
        narrowing: "window with --limit/--offset",
        verbose,
        empty: "No keys issued.",
        next: "ii revoke key <key-id>",
        row: (key) => key
      })
    }))
).pipe(Command.withDescription("List a client's API keys. Secrets are never shown again"))

export const grantCommand = Command.make(
  "grant",
  {
    clientId: Argument.string("client-id"),
    alias: Argument.string("alias"),
    tool: Argument.string("tool"),
    integration: Flag.string("integration").pipe(
      Flag.withDescription("Integration slug the alias resolves to")
    ),
    connection: connectionFlag(),
    requireApproval: Flag.boolean("require-approval").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Freeze this tool's calls for a human instead of running them")
    ),
    allow: Flag.boolean("allow").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Explicitly allow direct calls, overriding the tool's suggested policy")
    )
  },
  (options) => {
    if (options.requireApproval && options.allow) {
      return Effect.fail(cliError("Choose either --allow or --require-approval, not both"))
    }
    const decision = options.requireApproval
      ? "require_approval"
      : options.allow
        ? "allow"
        : undefined
    return controlPlaneTask((client) =>
      client.request("POST", "/v1/grants", {
        clientId: options.clientId,
        alias: options.alias,
        tool: options.tool,
        connection: {
          owner: "org",
          integration: options.integration,
          name: options.connection
        },
        ...whenPresent("decision", decision)
      })
    ).pipe(Effect.flatMap((result) =>
      writeStdoutLine(jsonOutput(record(result), false))
    ))
  }
).pipe(Command.withDescription("Delegate one tool through one connection to one client"))

export const revokeCommand = Command.make(
  "revoke",
  {
    kind: Argument.choice("kind", ["grant", "client", "key"]).pipe(
      Argument.withDescription("What to revoke")
    ),
    id: Argument.string("id")
  },
  ({ kind, id }) =>
    controlPlaneTask((client) =>
      client.request(
        "POST",
        kind === "grant"
          ? `/v1/grants/${encodeURIComponent(id)}/revoke`
          : kind === "client"
            ? `/v1/clients/${encodeURIComponent(id)}/revoke`
            : `/v1/keys/${encodeURIComponent(id)}/revoke`,
        {}
      )
    ).pipe(Effect.flatMap((result) => {
      const body = record(result)
      return writeStdoutLine(jsonOutput({ revoked: true, kind, id, ...body }, false))
    }))
).pipe(
  Command.withDescription(
    "Revoke a grant, a client, or one API key. Revoked rows stay as history"
  )
)
