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

/** Which connections one profile or policy tool command writes a rule for. Naming one is explicit;
 * naming none means every org connection currently live for that integration,
 * which is what an operator adding a tool usually means. */
const targetConnections = async (
  client: ControlPlaneClient,
  integration: string,
  requested: Option.Option<string>
): Promise<ReadonlyArray<{ readonly owner: string; readonly name: string }>> => {
  const explicit = Option.getOrUndefined(requested)
  if (explicit !== undefined) return [{ owner: "org", name: explicit }]
  const listed = array(record(await client.request("GET", "/v1/connections"))["connections"])
    .filter((entry) => text(entry["integration"]) === integration && text(entry["owner"]) === "org")
    .map((entry) => ({ owner: "org", name: text(entry["name"]) }))
  return listed.length === 0 ? [{ owner: "org", name: "default" }] : listed
}

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
    controlPlaneTask(async (client) => {
      const detail = record(await client.request(
        "GET",
        `/v1/access-profiles/${encodeURIComponent(accessProfileId)}`
      ))
      const targets = await targetConnections(client, integration, connection)
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
      return await client.request(
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
    }).pipe(Effect.flatMap((result) => writeStdoutLine(jsonOutput(record(result), false))))
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
    controlPlaneTask(async (client) => {
      const detail = record(await client.request(
        "GET",
        `/v1/approval-policies/${encodeURIComponent(approvalPolicyId)}`
      ))
      const targets = await targetConnections(client, integration, connection)
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
      return await client.request(
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
    }).pipe(Effect.flatMap((result) => writeStdoutLine(jsonOutput(record(result), false))))
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
