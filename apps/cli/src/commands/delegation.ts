import type { HttpClient } from "effect/http"
import { Effect, Option, Schema } from "effect"
import { whenPresent } from "@integragents/contracts"
import { Argument, Command, Flag } from "effect/cli"
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
  Flag.Boolean("verbose").pipe(
    Flag.withDefault(false),
    Flag.withAlias("v"),
    Flag.withDescription("Show complete objects, pretty-printed")
  )

const limitFlag = () =>
  Flag.Int("limit").pipe(
    Flag.optional,
    Flag.withDescription("Return at most this many rows (default: all of them)")
  )

const offsetFlag = () =>
  Flag.Int("offset").pipe(
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

export const profilesCommand = Command.make(
  "profiles",
  { limit: limitFlag(), offset: offsetFlag(), verbose: verboseFlag() },
  ({ limit, offset, verbose }) =>
    controlPlaneTask((client) => client.request("GET", "/v1/profiles")).pipe(
      Effect.flatMap((result) => {
        const all = sortedBy(array(record(result)["profiles"]), (entry) => text(record(entry["profile"])["name"]))
        return listing(page(all, window(limit, offset)), {
          key: "profiles",
          narrowing: "window with --limit/--offset",
          verbose,
          empty: "No profiles.",
          next: "ii profile-tools <profile-id>",
          row: (entry) => entry
        })
      })
    )
).pipe(Command.withDescription("List profiles with their tool, key, and connected-app counts"))

export const profileCommand = Command.make(
  "profile",
  {
    name: Argument.String("name"),
    copyFrom: Flag.String("copy-from").pipe(
      Flag.optional,
      Flag.withDescription("Start as an independent copy of this profile's tools and settings")
    ),
    includeNewTools: Flag.Boolean("include-new-tools").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Enable the tools of services connected later, with their default decision")
    ),
    provision: Flag.Boolean("provision").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Allow this profile to discover and connect integrations")
    ),
    administer: Flag.Boolean("administer").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Allow this profile to administer profiles, keys, approvals, and audit")
    )
  },
  ({ name, copyFrom, includeNewTools, provision, administer }) => {
    const capabilities = [
      ...(provision ? ["provision_connections"] : []),
      ...(administer ? ["administer_gateway"] : [])
    ]
    const body = {
      name,
      ...whenPresent("copyFrom", Option.getOrUndefined(copyFrom)),
      ...whenPresent("includeNewTools", includeNewTools || undefined),
      ...whenPresent("capabilities", capabilities.length === 0 ? undefined : capabilities)
    }
    return controlPlaneTask((client) => client.request("POST", "/v1/profiles", body)).pipe(
      Effect.flatMap((result) => {
        const created = record(result)
        return writeStdoutLine(jsonOutput(
          withNext(created, `ii profile-tool ${text(created["id"])} <integration> <tool> ask`),
          false
        ))
      })
    )
  }
).pipe(Command.withDescription("Create a profile: empty, or copied from another with --copy-from"))

export const profileToolsCommand = Command.make(
  "profile-tools",
  {
    profileId: Argument.String("profile-id"),
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ profileId, limit, offset, verbose }) =>
    controlPlaneTask((client) =>
      client.request("GET", `/v1/profiles/${encodeURIComponent(profileId)}/tools`)
    ).pipe(Effect.flatMap((result) => {
      const all = sortedBy(array(record(result)["tools"]), (tool) => `${text(tool["alias"])}.${text(tool["tool"])}`)
      return listing(page(all, window(limit, offset)), {
        key: "tools",
        narrowing: "window with --limit/--offset",
        verbose,
        empty: "No tools enabled.",
        next: `ii profile-tool ${profileId} <integration> <tool> off|ask|auto`,
        row: (tool) => tool
      })
    }))
).pipe(Command.withDescription("List the tools a profile enables and whether each asks first"))

const targetConnections = Effect.fn("Cli.targetConnections")(function*(
  client: ControlPlaneClient,
  integration: string,
  requested: Option.Option<string>
): Effect.fn.Return<
  ReadonlyArray<{ readonly owner: string; readonly name: string }>,
  IntegrationsCliError,
  HttpClient.HttpClient
> {
  const explicit = Option.getOrUndefined(requested)
  if (explicit !== undefined) return [{ owner: "org", name: explicit }]
  const connections = yield* client.request("GET", "/v1/connections")
  const listed = array(record(connections)["connections"])
    .filter((entry) => text(entry["integration"]) === integration && text(entry["owner"]) === "org")
    .map((entry) => ({ owner: "org", name: text(entry["name"]) }))
  return listed.length === 0 ? [{ owner: "org", name: "default" }] : listed
})

export const profileToolCommand = Command.make(
  "profile-tool",
  {
    profileId: Argument.String("profile-id"),
    integration: Argument.String("integration"),
    tool: Argument.String("tool"),
    setting: Argument.Literals("setting", ["off", "ask", "auto"]).pipe(
      Argument.withDescription("off: not callable; ask: each call waits for approval; auto: runs immediately")
    ),
    connection: Flag.String("connection").pipe(
      Flag.optional,
      Flag.withDescription("Set the tool on one connection only (default: every org connection of the integration)")
    )
  },
  ({ profileId, connection, integration, setting, tool }) =>
    controlPlaneTask((client) => Effect.gen(function*() {
      const route = `/v1/profiles/${encodeURIComponent(profileId)}/tools`
      const current = array(record(yield* client.request("GET", route))["tools"])
      const targets = yield* targetConnections(client, integration, connection)
      const replaced = new Set(targets.map((target) => `${target.owner}/${target.name}`))
      const kept = current
        .filter((entry) => {
          const existing = record(entry["connection"])
          return text(existing["integration"]) !== integration ||
            text(entry["tool"]) !== tool ||
            !replaced.has(`${text(existing["owner"])}/${text(existing["name"])}`)
        })
        .map((entry) => ({
          connection: record(entry["connection"]),
          tool: text(entry["tool"]),
          decision: text(entry["decision"])
        }))
      return yield* client.request("POST", route, {
        tools: setting === "off"
          ? kept
          : [
            ...kept,
            ...targets.map((target) => ({
              connection: { owner: target.owner, integration, name: target.name },
              tool,
              decision: setting === "auto" ? "allow" : "require_approval"
            }))
          ]
      })
    })).pipe(Effect.flatMap((result) => writeStdoutLine(jsonOutput(record(result), false))))
).pipe(Command.withDescription("Turn one tool off, or on with ask or auto, in a profile"))

export const keyCommand = Command.make(
  "key",
  {
    profileId: Argument.String("profile-id"),
    name: Argument.String("name").pipe(
      Argument.withDescription("The app that will use the key, such as \"Claude Code\". Calls are attributed to it")
    )
  },
  ({ name, profileId }) =>
    controlPlaneTask((client) =>
      client.request("POST", `/v1/profiles/${encodeURIComponent(profileId)}/keys`, { name })
    ).pipe(Effect.flatMap((result) => {
      const issued = record(result)
      return writeStdoutLine(jsonOutput(issued, false))
    }))
).pipe(Command.withDescription("Issue an API key for one app of a profile. Shown once"))

export const keysCommand = Command.make(
  "keys",
  {
    profileId: Argument.String("profile-id"),
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ profileId, limit, offset, verbose }) =>
    controlPlaneTask((client) =>
      client.request("GET", `/v1/profiles/${encodeURIComponent(profileId)}/keys`)
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
).pipe(Command.withDescription("List a profile's API keys. Secrets are never shown again"))

export const revokeCommand = Command.make(
  "revoke",
  {
    kind: Argument.Literals("kind", ["profile", "key"]).pipe(
      Argument.withDescription("What to revoke")
    ),
    id: Argument.String("id")
  },
  ({ kind, id }) =>
    controlPlaneTask((client) =>
      client.request(
        "POST",
        kind === "profile"
          ? `/v1/profiles/${encodeURIComponent(id)}/revoke`
          : `/v1/keys/${encodeURIComponent(id)}/revoke`,
        {}
      )
    ).pipe(Effect.flatMap((result) => {
      const body = record(result)
      return writeStdoutLine(jsonOutput({ revoked: true, kind, id, ...body }, false))
    }))
).pipe(
  Command.withDescription(
    "Revoke a profile or one API key. Revoked rows stay as history"
  )
)
