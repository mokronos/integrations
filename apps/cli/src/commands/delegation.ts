import type { HttpClient } from "effect/unstable/http"
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
).pipe(Command.withDescription("List clients and their assigned access profiles and approval policies"))

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
      Flag.withDescription("Allow this client to administer clients, keys, access profiles, approval policies, approvals, and audit")
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
).pipe(Command.withDescription("Create a client assigned to the default access profile and approval policy"))

export const keyCommand = Command.make(
  "key",
  { clientId: Argument.string("client-id") },
  ({ clientId }) =>
    controlPlaneTask((client) =>
      client.request("POST", `/v1/clients/${encodeURIComponent(clientId)}/keys`, {})
    ).pipe(Effect.flatMap((result) => {
      const issued = record(result)
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

export const accessProfilesCommand = Command.make(
  "access-profiles",
  {
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ limit, offset, verbose }) =>
    controlPlaneTask((client) => client.request("GET", "/v1/access-profiles")).pipe(
      Effect.flatMap((result) => {
        const all = sortedBy(array(record(result)["accessProfiles"]), (entry) =>
          text(record(entry["accessProfile"])["name"]))
        return listing(page(all, window(limit, offset)), {
          key: "accessProfiles",
          narrowing: "window with --limit/--offset",
          verbose,
          empty: "No access profiles.",
          row: (entry) => entry
        })
      })
    )
).pipe(Command.withDescription("List reusable tool-access profiles"))

export const accessProfileCommand = Command.make(
  "access-profile",
  { name: Argument.string("name") },
  ({ name }) =>
    controlPlaneTask((client) => client.request("POST", "/v1/access-profiles", { name })).pipe(
      Effect.flatMap((result) => writeStdoutLine(jsonOutput(record(result), false)))
    )
).pipe(Command.withDescription("Create an empty reusable access profile"))

export const cloneAccessProfileCommand = Command.make(
  "clone-access-profile",
  {
    accessProfileId: Argument.string("access-profile-id"),
    name: Argument.string("name")
  },
  ({ accessProfileId, name }) =>
    controlPlaneTask((client) => client.request(
      "POST",
      `/v1/access-profiles/${encodeURIComponent(accessProfileId)}/clone`,
      { name }
    )).pipe(Effect.flatMap((result) => writeStdoutLine(jsonOutput(record(result), false))))
).pipe(Command.withDescription("Clone an access profile and all of its tools"))

const targetConnections = Effect.fn("cli.targetConnections")(function*(
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

export const accessProfileToolCommand = Command.make(
  "access-profile-tool",
  {
    accessProfileId: Argument.string("access-profile-id"),
    integration: Argument.string("integration"),
    tool: Argument.string("tool"),
    connection: Flag.string("connection").pipe(
      Flag.optional,
      Flag.withDescription(
        "Write the rule for one connection only (default: every org connection of the integration)"
      )
    )
  },
  ({ accessProfileId, connection, integration, tool }) =>
    controlPlaneTask((client) => Effect.gen(function*() {
      const detail = record(yield* client.request(
        "GET",
        `/v1/access-profiles/${encodeURIComponent(accessProfileId)}`
      ))
      const targets = yield* targetConnections(client, integration, connection)
      const replaced = new Set(targets.map((target) => `${target.owner}/${target.name}`))
      const tools = array(detail["tools"])
        .filter((entry) => {
          const existing = record(entry["connection"])
          return text(existing["integration"]) !== integration ||
            text(entry["tool"]) !== tool ||
            !replaced.has(`${text(existing["owner"])}/${text(existing["name"])}`)
        })
        .map((entry) => ({
          connection: record(entry["connection"]),
          tool: text(entry["tool"])
        }))
      return yield* client.request(
        "POST",
        `/v1/access-profiles/${encodeURIComponent(accessProfileId)}/tools`,
        {
          tools: [
            ...tools,
            ...targets.map((target) => ({
              connection: { owner: target.owner, integration, name: target.name },
              tool
            }))
          ]
        }
      )
    })).pipe(Effect.flatMap((result) => writeStdoutLine(jsonOutput(record(result), false))))
).pipe(Command.withDescription("Include one tool in an access profile"))

export const approvalPoliciesCommand = Command.make(
  "approval-policies",
  {
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ limit, offset, verbose }) =>
    controlPlaneTask((client) => client.request("GET", "/v1/approval-policies")).pipe(
      Effect.flatMap((result) => {
        const all = sortedBy(array(record(result)["approvalPolicies"]), (entry) =>
          text(record(entry["approvalPolicy"])["name"]))
        return listing(page(all, window(limit, offset)), {
          key: "approvalPolicies",
          narrowing: "window with --limit/--offset",
          verbose,
          empty: "No approval policies.",
          row: (entry) => entry
        })
      })
    )
).pipe(Command.withDescription("List reusable approval policies"))

export const approvalPolicyCommand = Command.make(
  "approval-policy",
  { name: Argument.string("name") },
  ({ name }) =>
    controlPlaneTask((client) => client.request("POST", "/v1/approval-policies", { name })).pipe(
      Effect.flatMap((result) => writeStdoutLine(jsonOutput(record(result), false)))
    )
).pipe(Command.withDescription("Create an empty reusable approval policy"))

export const cloneApprovalPolicyCommand = Command.make(
  "clone-approval-policy",
  {
    approvalPolicyId: Argument.string("approval-policy-id"),
    name: Argument.string("name")
  },
  ({ approvalPolicyId, name }) =>
    controlPlaneTask((client) => client.request(
      "POST",
      `/v1/approval-policies/${encodeURIComponent(approvalPolicyId)}/clone`,
      { name }
    )).pipe(Effect.flatMap((result) => writeStdoutLine(jsonOutput(record(result), false))))
).pipe(Command.withDescription("Clone an approval policy and all of its decisions"))

export const approvalPolicyToolCommand = Command.make(
  "approval-policy-tool",
  {
    approvalPolicyId: Argument.string("approval-policy-id"),
    integration: Argument.string("integration"),
    tool: Argument.string("tool"),
    mode: Argument.choice("mode", ["allow", "require-approval"]),
    connection: Flag.string("connection").pipe(
      Flag.optional,
      Flag.withDescription(
        "Write the decision for one connection only (default: every org connection of the integration)"
      )
    )
  },
  ({ approvalPolicyId, connection, integration, mode, tool }) =>
    controlPlaneTask((client) => Effect.gen(function*() {
      const detail = record(yield* client.request(
        "GET",
        `/v1/approval-policies/${encodeURIComponent(approvalPolicyId)}`
      ))
      const targets = yield* targetConnections(client, integration, connection)
      const replaced = new Set(targets.map((target) => `${target.owner}/${target.name}`))
      const tools = array(detail["tools"])
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
      return yield* client.request(
        "POST",
        `/v1/approval-policies/${encodeURIComponent(approvalPolicyId)}/tools`,
        {
          tools: [
            ...tools,
            ...targets.map((target) => ({
              connection: { owner: target.owner, integration, name: target.name },
              tool,
              decision: mode === "allow" ? "allow" : "require_approval"
            }))
          ]
        }
      )
    })).pipe(Effect.flatMap((result) => writeStdoutLine(jsonOutput(record(result), false))))
).pipe(Command.withDescription("Set one tool's decision in an approval policy"))

export const assignAccessProfileCommand = Command.make(
  "assign-access-profile",
  {
    clientId: Argument.string("client-id"),
    accessProfileId: Argument.string("access-profile-id")
  },
  ({ accessProfileId, clientId }) =>
    controlPlaneTask((client) => client.request(
      "POST",
      `/v1/clients/${encodeURIComponent(clientId)}/access-profile`,
      { accessProfileId }
    )).pipe(Effect.flatMap((result) => writeStdoutLine(jsonOutput(record(result), false))))
).pipe(Command.withDescription("Assign one reusable access profile to a client"))

export const assignApprovalPolicyCommand = Command.make(
  "assign-approval-policy",
  {
    clientId: Argument.string("client-id"),
    approvalPolicyId: Argument.string("approval-policy-id")
  },
  ({ approvalPolicyId, clientId }) =>
    controlPlaneTask((client) => client.request(
      "POST",
      `/v1/clients/${encodeURIComponent(clientId)}/approval-policy`,
      { approvalPolicyId }
    )).pipe(Effect.flatMap((result) => writeStdoutLine(jsonOutput(record(result), false))))
).pipe(Command.withDescription("Assign one reusable approval policy to a client"))

export const revokeCommand = Command.make(
  "revoke",
  {
    kind: Argument.choice("kind", ["client", "key"]).pipe(
      Argument.withDescription("What to revoke")
    ),
    id: Argument.string("id")
  },
  ({ kind, id }) =>
    controlPlaneTask((client) =>
      client.request(
        "POST",
        kind === "client"
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
    "Revoke a client or one API key. Revoked rows stay as history"
  )
)
