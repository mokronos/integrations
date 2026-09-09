import { whenPresent } from "@integrations/contracts"
import type { GatewayClient } from "@mokronos/integrations-client"
import type { HttpClient } from "effect/unstable/http"
import { Effect, Option, Predicate, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { ApprovalId } from "@integrations/gateway-core/domain"
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

const gatewayTask = <A, E, R>(
  task: (client: GatewayClient) => Effect.Effect<A, E, R>
): Effect.Effect<A, IntegrationsCliError, R | HttpClient.HttpClient> =>
  connectToGateway().pipe(
    Effect.flatMap(task),
    Effect.mapError((error) => cliError(describeError(error)))
  )

const controlPlaneTask = <A, E>(
  task: (client: ControlPlaneClient) => Effect.Effect<A, E, HttpClient.HttpClient>
): Effect.Effect<A, IntegrationsCliError, HttpClient.HttpClient> =>
  connectToControlPlane().pipe(
    Effect.flatMap(task),
    Effect.mapError((error) => cliError(describeError(error)))
  )

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
    gatewayTask((client) => client.delegated.approval({ params: { id: ApprovalId.make(id) } })).pipe(Effect.flatMap((approval) =>
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
