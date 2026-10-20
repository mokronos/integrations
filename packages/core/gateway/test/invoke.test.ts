import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { whenPresent } from "@integragents/contracts"
import {
  HostTools,
  Integrations,
  McpClient,
  OpenApiInvoker,
  stubbedLayer,
  unavailableHttpClientLayer
} from "@integragents/host"
import type { HostIntegrationDefinition, HostToolInvocation } from "@integragents/host"
import {
  aliasForConnection,
  approveApproval,
  ConnectionName,
  defaultTenantId,
  IntegrationSlug,
  invokeAsProfile,
  newProfileId,
  registerHostIntegration,
  SubjectId,
  ToolName,
  unattributedOrigin
} from "../src/index.ts"
import type { ConnectionRef, CreateProfileInput, GatewayStore, Profile, ToolDecision } from "../src/index.ts"
import { gatewayStore, testServices } from "./fixtures.ts"

type Json = typeof import("effect").Schema.Json.Type

const sandbox = IntegrationSlug.make("sandbox")
const runCommand = ToolName.make("run_command")
const sandboxConnection: ConnectionRef = { owner: "org", integration: sandbox, name: ConnectionName.make("default") }
const alias = aliasForConnection(sandboxConnection)
const alice = SubjectId.make("alice")
const bob = SubjectId.make("bob")

const definition: HostIntegrationDefinition = {
  slug: sandbox,
  name: "Sandbox",
  tools: [
    {
      name: runCommand,
      description: "Run a shell command in the user's VM",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    }
  ]
}

const unusedMcp = Layer.succeed(McpClient, {
  probe: () => Effect.die("unused"),
  listTools: () => Effect.die("unused"),
  callTool: () => Effect.die("unused")
})

/** The real integration host with a sandbox integration whose commands land in `seen`. */
const hostLayer = (seen: Array<HostToolInvocation>) =>
  Layer.mergeAll(
    stubbedLayer(Layer.mergeAll(unusedMcp, OpenApiInvoker.unavailableTestLayer)).pipe(
      Layer.provide(
        HostTools.layer({
          execute: (invocation) =>
            Effect.sync((): Json => {
              seen.push(invocation)
              return { exitCode: 0, ran: invocation.arguments }
            })
        })
      )
    ),
    unavailableHttpClientLayer,
    testServices
  )

const harness = Effect.fnUntraced(function* (
  options: { readonly decision?: ToolDecision; readonly profile?: Partial<CreateProfileInput> } = {}
) {
  const store = yield* gatewayStore("gateway-invoke-")
  const integrations = yield* Integrations
  yield* integrations.registerHostIntegration(definition)
  const profile = yield* store.createProfile({
    id: yield* newProfileId,
    tenantId: defaultTenantId,
    name: "vm-agent",
    capabilities: [],
    tools: [{ connection: sandboxConnection, tool: runCommand, decision: options.decision ?? "allow" }],
    ...options.profile
  })
  const dependencies = { store, integrations, retentionDays: 30 }
  const invoke = (command: string, extra: { readonly subject?: typeof alice; readonly profile?: Profile } = {}) =>
    invokeAsProfile(dependencies, {
      profile: extra.profile ?? profile,
      origin: unattributedOrigin,
      alias,
      tool: runCommand,
      arguments: { command },
      ...whenPresent("subject", extra.subject)
    })
  return { store, integrations, profile, dependencies, invoke }
})

/** Records written in the same millisecond have no order between them, so only what was recorded is compared. */
const auditOf = (store: GatewayStore) =>
  Effect.map(store.listAudit(defaultTenantId, {}), (records) =>
    records.map((record) => [record.outcome, record.approval, record.message]).toSorted()
  )

describe("host tools through the gateway", () => {
  it.effect("an approved host tool runs after the decision, told who it acts for and under which approval", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { store, profile, dependencies, invoke } = yield* harness({ decision: "require_approval" })

      const pending = yield* invoke("rm -rf build", { subject: alice })
      if (pending.status !== "pending") return yield* Effect.die(`expected pending, got ${pending.status}`)
      expect(seen).toEqual([])

      const { outcome } = yield* approveApproval(dependencies, {
        tenantId: defaultTenantId,
        id: pending.approvalId,
        decidedBy: "operator@example.com"
      })

      expect(outcome).toEqual({ status: "succeeded", result: { exitCode: 0, ran: { command: "rm -rf build" } } })
      expect(seen.map((call) => [call.handler, call.context])).toEqual([
        [
          "run_command",
          { tenantId: defaultTenantId, profileId: profile.id, subject: alice, approvalId: pending.approvalId }
        ]
      ])
      expect(yield* auditOf(store)).toEqual(
        [
          ["pending", null, `approval ${pending.approvalId}`],
          ["succeeded", "approved", "approved by operator@example.com"]
        ].toSorted()
      )
    }).pipe(Effect.provide(hostLayer(seen)))
  })

  it.effect(
    "a host integration joins the profiles that take new tools when it is first registered, not on restart",
    () => {
      const seen: Array<HostToolInvocation> = []
      return Effect.gen(function* () {
        const store = yield* gatewayStore("gateway-invoke-")
        const integrations = yield* Integrations
        const create = (name: string, includeNewTools: boolean) =>
          Effect.flatMap(newProfileId, (id) =>
            store.createProfile({ id, tenantId: defaultTenantId, name, capabilities: [], includeNewTools, tools: [] })
          )
        const taking = yield* create("taking", true)
        const keeping = yield* create("keeping", false)
        const withReader = {
          ...definition,
          tools: [...definition.tools, { name: ToolName.make("read_file"), description: "Read a file", readOnly: true }]
        }
        const enabled = (profile: Profile) =>
          Effect.map(store.listProfileTools(profile.id), (tools) => tools.map((tool) => [tool.tool, tool.decision]))

        yield* registerHostIntegration({ store, integrations, definition: withReader })
        const afterFirst = { taking: yield* enabled(taking), keeping: yield* enabled(keeping) }
        yield* store.replaceProfileTools(taking.id, [])
        yield* registerHostIntegration({ store, integrations, definition: withReader })

        expect(afterFirst).toEqual({
          taking: [
            ["read_file", "allow"],
            ["run_command", "require_approval"]
          ],
          keeping: []
        })
        expect(yield* enabled(taking)).toEqual([])
      }).pipe(Effect.provide(hostLayer(seen)))
    }
  )

  it.effect("the same command for two people waits for two decisions", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { invoke } = yield* harness({ decision: "require_approval" })

      const forAlice = yield* invoke("reboot", { subject: alice })
      const forBob = yield* invoke("reboot", { subject: bob })
      const aliceAgain = yield* invoke("reboot", { subject: alice })

      const ids = [forAlice, forBob, aliceAgain].map((outcome) =>
        outcome.status === "pending" ? outcome.approvalId : outcome.status
      )
      expect(ids[0]).not.toEqual(ids[1])
      expect(ids[2]).toEqual(ids[0])
    }).pipe(Effect.provide(hostLayer(seen)))
  })
})
