import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ToolAddress } from "@integragents/contracts"
import type { Integrations } from "@integragents/host"
import {
  Alias,
  ConnectionName,
  IntegrationSlug,
  ToolName,
  defaultTenantId,
  includeConnectionTools,
  listEffectiveTools,
  newProfileId,
  pruneProfileTools
} from "../src/index.ts"
import type { GatewayStore, ProfileToolInput } from "../src/index.ts"
import { gatewayStore, testServices } from "./fixtures.ts"

const connection = (integration: string, name: string) => ({
  owner: "org" as const,
  integration: IntegrationSlug.make(integration),
  name: ConnectionName.make(name)
})

const summary = (
  integration: string,
  name: string,
  tool: string,
  defaultDecision: "allow" | "require_approval" = "allow"
) => ({
  address: ToolAddress.make(`tools.${integration}.org.${name}.${tool}`),
  name: ToolName.make(tool),
  description: tool,
  integration: IntegrationSlug.make(integration),
  owner: "org" as const,
  connection: ConnectionName.make(name),
  defaultDecision
})

const catalog = (tools: ReadonlyArray<ReturnType<typeof summary>>) => ({
  toolSummaries: (scope) =>
    Effect.succeed(tools.filter((tool) =>
      (scope?.integration === undefined || tool.integration === scope.integration)
      && (scope?.connection === undefined || tool.connection === scope.connection)))
} satisfies Pick<Integrations["Service"], "toolSummaries">)

const mailAndCalendar = catalog([
  summary("mail", "primary", "readEmail", "allow"),
  summary("mail", "primary", "sendEmail", "require_approval"),
  summary("calendar", "primary", "createEvent", "require_approval")
])

const createProfile = Effect.fnUntraced(function*(
  store: GatewayStore,
  name: string,
  options: { readonly includeNewTools?: boolean; readonly tools?: ReadonlyArray<ProfileToolInput> } = {}
) {
  return yield* store.createProfile({
    id: yield* newProfileId,
    tenantId: defaultTenantId,
    name,
    capabilities: [],
    includeNewTools: options.includeNewTools ?? false,
    tools: options.tools ?? []
  })
})

const connect = (store: GatewayStore, integration: string, name: string) =>
  includeConnectionTools({
    store,
    integrations: mailAndCalendar,
    tenantId: defaultTenantId,
    integration: IntegrationSlug.make(integration),
    connection: ConnectionName.make(name)
  })

const decisions = (store: GatewayStore, profileId: Parameters<GatewayStore["listProfileTools"]>[0]) =>
  Effect.map(store.listProfileTools(profileId), (tools) =>
    tools.map((row) => `${row.connection.integration}.${row.tool}=${row.decision}`).sort())

const store = gatewayStore("gateway-profiles-")

describe("profiles", () => {
  it.effect("a new connection joins only the live profiles that include new tools, with default decisions", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const including = yield* createProfile(gateway, "including", { includeNewTools: true })
      const fixed = yield* createProfile(gateway, "fixed", {
        tools: [{ connection: connection("calendar", "primary"), tool: ToolName.make("createEvent"), decision: "allow" }]
      })
      const revoked = yield* createProfile(gateway, "revoked", { includeNewTools: true })
      yield* gateway.revokeProfile(defaultTenantId, revoked.id)

      yield* connect(gateway, "mail", "primary")

      expect(yield* decisions(gateway, including.id))
        .toEqual(["mail.readEmail=allow", "mail.sendEmail=require_approval"])
      expect(yield* decisions(gateway, fixed.id)).toEqual(["calendar.createEvent=allow"])
      expect(yield* gateway.listProfileTools(revoked.id)).toEqual([])
    }).pipe(Effect.provide(testServices)))

  it.effect("a tool turned off or re-decided stays that way when other connections arrive or the catalog is pruned", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const profile = yield* createProfile(gateway, "agent", { includeNewTools: true })
      yield* connect(gateway, "mail", "primary")
      yield* gateway.replaceProfileTools(profile.id, [
        { connection: connection("mail", "primary"), tool: ToolName.make("readEmail"), decision: "require_approval" }
      ])

      yield* connect(gateway, "calendar", "primary")
      yield* pruneProfileTools({ store: gateway, integrations: mailAndCalendar, tenantId: defaultTenantId })

      expect(yield* decisions(gateway, profile.id))
        .toEqual(["calendar.createEvent=require_approval", "mail.readEmail=require_approval"])
    }).pipe(Effect.provide(testServices)))

  it.effect("pruning drops tools on org connections the catalog no longer has, and keeps delegated ones", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const template = { owner: "user" as const, integration: IntegrationSlug.make("mail"), name: ConnectionName.make("own") }
      const profile = yield* createProfile(gateway, "agent", {
        tools: [
          { connection: connection("mail", "primary"), tool: ToolName.make("sendEmail"), decision: "allow" },
          { connection: connection("legacy", "default"), tool: ToolName.make("ping"), decision: "allow" },
          { connection: template, tool: ToolName.make("sendEmail"), decision: "require_approval" }
        ]
      })

      yield* pruneProfileTools({ store: gateway, integrations: mailAndCalendar, tenantId: defaultTenantId })

      expect(
        (yield* gateway.listProfileTools(profile.id))
          .map((row) => [row.connection.owner, row.connection.integration, row.tool, row.decision]).sort()
      ).toEqual([["org", "mail", "sendEmail", "allow"], ["user", "mail", "sendEmail", "require_approval"]])
    }).pipe(Effect.provide(testServices)))

  it.effect("lists a profile's tools under their aliases, delegated ones marked", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const template = { owner: "user" as const, integration: IntegrationSlug.make("mail"), name: ConnectionName.make("own") }
      const profile = yield* createProfile(gateway, "agent", {
        tools: [
          { connection: connection("calendar", "primary"), tool: ToolName.make("createEvent"), decision: "allow" },
          { connection: template, tool: ToolName.make("sendEmail"), decision: "require_approval" }
        ]
      })

      expect(yield* listEffectiveTools(gateway, profile.id)).toEqual([
        {
          alias: Alias.make("org___calendar___primary"),
          tool: ToolName.make("createEvent"),
          connection: connection("calendar", "primary"),
          decision: "allow",
          delegated: false
        },
        {
          alias: Alias.make("user___mail___own"),
          tool: ToolName.make("sendEmail"),
          connection: template,
          decision: "require_approval",
          delegated: true
        }
      ])
    }).pipe(Effect.provide(testServices)))

  it.effect("editing one profile leaves every other profile as it was", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const mail = { connection: connection("mail", "primary"), tool: ToolName.make("sendEmail") }
      const alpha = yield* createProfile(gateway, "alpha", { tools: [{ ...mail, decision: "allow" }] })
      const beta = yield* createProfile(gateway, "beta", { tools: [{ ...mail, decision: "allow" }] })

      yield* gateway.replaceProfileTools(alpha.id, [{ ...mail, decision: "require_approval" }])

      expect(yield* decisions(gateway, alpha.id)).toEqual(["mail.sendEmail=require_approval"])
      expect(yield* decisions(gateway, beta.id)).toEqual(["mail.sendEmail=allow"])
    }).pipe(Effect.provide(testServices)))
})
