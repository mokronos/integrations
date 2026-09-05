import { whenPresent } from "@mokronos/contracts"
import type { GatewayClient } from "@mokronos/integrations-client"
import { Effect, Option, Predicate, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import type { IntegrationsCliError } from "../connection.ts"
import { cliError, connectToGateway, describeError } from "../connection.ts"
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

export const approvalsCommand = Command.make(
  "approvals",
  {
    status: Flag.choice("status", ["pending", "executing", "approved", "denied", "expired"]).pipe(Flag.optional),
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ status, limit, offset, verbose }) =>
    controlPlaneTask((client) =>
      client.request(
        "GET",
        Option.isNone(status) ? "/v1/approvals" : `/v1/approvals?status=${status.value}`
      )
    ).pipe(Effect.flatMap((result) => {
      // Newest first: an approvals queue is read at its head, not its tail.
      const all = [...array(record(result)["approvals"])].sort((left, right) =>
        text(right["createdAt"]).localeCompare(text(left["createdAt"]))
      )
      return listing(page(all, window(limit, offset)), {
        key: "approvals",
        narrowing: "narrow with --status, or window with --limit/--offset",
        verbose,
        empty: "No approvals.",
        next: "ii approve <id>",
        row: (approval) => approval
      })
    }))
).pipe(Command.withDescription("List frozen invocations awaiting a decision"))

export const approvalCommand = Command.make(
  "approval",
  { id: Argument.string("approval-id"), verbose: verboseFlag() },
  ({ id, verbose }) =>
    // Deliberately the delegated route: the caller that proposed a frozen call
    // is the one that needs to watch it, and that caller holds no administrative
    // key. Without this, `execute` hands back an id nothing can resolve.
    gatewayTask((client) => client.approval(id)).pipe(Effect.flatMap((approval) =>
      writeStdoutLine(jsonOutput(approval, verbose))
    ))
).pipe(Command.withDescription("Read one frozen invocation, as the caller that proposed it"))


export const approveCommand = Command.make(
  "approve",
  {
    id: Argument.string("approval-id"),
    verbose: verboseFlag()
  },
  ({ id, verbose }) =>
    controlPlaneTask((client) =>
      client.request("POST", `/v1/approvals/${encodeURIComponent(id)}/approve`, {})
    ).pipe(Effect.flatMap((result) => {
      const body = record(result)
      // The gateway performed the call. Approving discharged one frozen
      // invocation; it did not hand anyone a capability.
      return writeStdoutLine(jsonOutput(body, verbose))
    }))
).pipe(Command.withDescription("Approve a frozen invocation; the gateway then performs it"))

export const denyCommand = Command.make(
  "deny",
  {
    id: Argument.string("approval-id"),
    verbose: verboseFlag()
  },
  ({ id, verbose }) =>
    controlPlaneTask((client) =>
      client.request("POST", `/v1/approvals/${encodeURIComponent(id)}/deny`, {})
    ).pipe(Effect.flatMap((result) =>
      writeStdoutLine(jsonOutput(record(result), verbose))
    ))
).pipe(Command.withDescription("Deny a frozen invocation"))

export const auditCommand = Command.make(
  "audit",
  {
    limit: Flag.integer("limit").pipe(
      Flag.withDefault(50),
      Flag.withDescription("How many records to read (default: 50)")
    ),
    offset: offsetFlag(),
    client: Flag.string("client").pipe(Flag.optional, Flag.withDescription("Only this client id")),
    alias: Flag.string("alias").pipe(Flag.optional, Flag.withDescription("Only this alias")),
    tool: Flag.string("tool").pipe(Flag.optional, Flag.withDescription("Only this tool")),
    outcome: Flag.choice("outcome", ["succeeded", "failed", "denied", "pending"]).pipe(
      Flag.optional,
      Flag.withDescription("Only this outcome")
    ),
    since: Flag.string("since").pipe(
      Flag.optional,
      Flag.withDescription("Only records at or after this time (ISO 8601)")
    ),
    verbose: verboseFlag()
  },
  (options) =>
    controlPlaneTask((client) => {
      // The one listing read through a window rather than whole: the trail is
      // permanent, so "all of it" grows without bound. It is filtered and
      // windowed at the gateway rather than here for the same reason.
      const parameters = new URLSearchParams({
        limit: String(options.limit),
        offset: String(Option.getOrElse(options.offset, () => 0))
      })
      if (Option.isSome(options.client)) parameters.set("clientId", options.client.value)
      if (Option.isSome(options.alias)) parameters.set("alias", options.alias.value)
      if (Option.isSome(options.tool)) parameters.set("tool", options.tool.value)
      if (Option.isSome(options.outcome)) parameters.set("outcome", options.outcome.value)
      if (Option.isSome(options.since)) parameters.set("since", options.since.value)
      return client.request("GET", `/v1/audit?${parameters.toString()}`)
    }).pipe(Effect.flatMap((result) => {
      const body = record(result)
      const records = array(body["records"])
      const total = Predicate.isNumber(body["total"]) ? body["total"] : records.length
      const offset = Predicate.isNumber(body["offset"]) ? body["offset"] : 0
      return writeStdoutLine(jsonOutput(
        { records, count: total, showing: records.length, offset },
        options.verbose
      ))
    }))
).pipe(Command.withDescription("Read the gateway's audit trail"))

export const driftCommand = Command.make(
  "drift",
  {
    integration: Argument.string("integration").pipe(Argument.optional),
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ integration, limit, offset, verbose }) =>
    controlPlaneTask((client) =>
      client.request(
        "POST",
        Option.isNone(integration)
          ? "/v1/drift/refresh"
          : `/v1/drift/refresh?integration=${encodeURIComponent(integration.value)}`
      )
    ).pipe(Effect.flatMap((result) => {
      const reports = array(record(result)["reports"])
      const baselines = reports.filter((report) => report["baseline"] === true)
      const entries = sortedBy(
        reports.flatMap((report): ReadonlyArray<Record<string, typeof Schema.Json.Type>> =>
          array(report["entries"]).map((entry) => ({ ...entry, integration: report["integration"] ?? null }))
        ),
        (entry) => `${text(entry["integration"])} ${text(entry["tool"])}`
      )
      // A first sync has nothing to compare against. Saying so beats reporting
      // an integration's entire surface as newly added.
      const baselineNote = baselines.length === 0
        ? undefined
        : `Recorded a baseline for ${baselines.map((report) => text(report["integration"])).join(", ")
        }; drift is reported from the next refresh.`
      return listing(page(entries, window(limit, offset)), {
        key: "drift",
        narrowing: "window with --limit/--offset",
        verbose,
        empty: baselineNote ?? "No drift since the last refresh.",
        extra: {
          checked: reports.length,
          ...whenPresent("baseline", baselineNote)
        },
        row: (entry) => entry
      })
    }))
).pipe(
  Command.withDescription(
    "Re-read tools and report what a vendor added, removed, or reshaped since the last sync"
  )
)


export const maintenanceCommand = Command.make(
  "maintenance",
  {},
  () =>
    controlPlaneTask((client) => client.request("POST", "/v1/maintenance", {})).pipe(
      Effect.flatMap((result) => {
        const body = record(result)
        return writeStdoutLine(jsonOutput(body, false))
      })
    )
).pipe(
  Command.withDescription(
    "Run the sweep the gateway runs on a clock: expire frozen calls and aged-out arguments"
  )
)
