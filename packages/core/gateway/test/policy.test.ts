import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ToolAddress } from "@integrations/contracts"
import type { Integrations } from "@integrations/integrations"
import {
  Alias,
  ClientId,
  ConnectionName,
  IntegrationSlug,
  ToolName,
  authorizeInvocation,
  defaultTenantId,
  generateApiKey,
  listEffectiveTools,
  newAccessProfileId,
  newApprovalPolicyId,
  reconcileConfigurations
} from "../src/index.ts"
import type { AccessProfileId, ApprovalPolicyId, GatewayStore } from "../src/index.ts"
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
  toolSummaries: () => Effect.succeed(tools)
} satisfies Pick<Integrations["Service"], "toolSummaries">)

const createClient = Effect.fnUntraced(function*(
  store: GatewayStore,
  name: string,
  accessProfileId: AccessProfileId,
  approvalPolicyId: ApprovalPolicyId
) {
  const client = yield* store.createClient({
    id: ClientId.make(`${name}-client`), tenantId: defaultTenantId, name,
    accessProfileId, approvalPolicyId, capabilities: []
  })
  const key = yield* generateApiKey
  yield* store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })
  return { client, key }
})

const store = gatewayStore("gateway-policy-")

describe("access profiles and approval policies", () => {
  it.effect("reconciles access defaults and every approval policy without overwriting decisions", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const accessProfile = yield* gateway.findDefaultAccessProfile(defaultTenantId)
      const approvalPolicy = yield* gateway.findDefaultApprovalPolicy(defaultTenantId)
      if (accessProfile === undefined || approvalPolicy === undefined) {
        throw new Error("missing defaults")
      }
      yield* gateway.replaceApprovalPolicyTools(approvalPolicy.id, [{
        connection: connection("mail", "primary"),
        tool: ToolName.make("sendEmail"),
        decision: "require_approval"
      }])
      const customPolicy = yield* gateway.createApprovalPolicy({
        id: yield* newApprovalPolicyId,
        tenantId: defaultTenantId,
        name: "Custom",
        tools: [{
          connection: connection("mail", "primary"),
          tool: ToolName.make("sendEmail"),
          decision: "require_approval"
        }]
      })

      yield* reconcileConfigurations({
        store: gateway,
        tenantId: defaultTenantId,
        integrations: catalog([
          summary("mail", "primary", "sendEmail", "allow"),
          summary("calendar", "primary", "createEvent", "allow")
        ])
      })

      expect((yield* gateway.listAccessProfileTools(accessProfile.id)).map((row) => row.tool).sort())
        .toEqual([ToolName.make("createEvent"), ToolName.make("sendEmail")])
      expect(
        (yield* gateway.listApprovalPolicyTools(approvalPolicy.id))
          .map((row) => [row.tool, row.decision]).sort()
      ).toEqual([[ToolName.make("createEvent"), "allow"], [ToolName.make("sendEmail"), "require_approval"]])
      expect(
        (yield* gateway.listApprovalPolicyTools(customPolicy.id))
          .map((row) => [row.tool, row.decision]).sort()
      ).toEqual([[ToolName.make("createEvent"), "allow"], [ToolName.make("sendEmail"), "require_approval"]])
    }).pipe(Effect.provide(testServices)))

  it.effect("uses the access profile for reach and the approval policy for decisions", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const accessProfile = yield* gateway.createAccessProfile({
        id: yield* newAccessProfileId, tenantId: defaultTenantId, name: "Mail access"
      })
      const approvalPolicy = yield* gateway.createApprovalPolicy({
        id: yield* newApprovalPolicyId, tenantId: defaultTenantId, name: "Reviewed actions", tools: []
      })
      yield* gateway.replaceAccessProfileTools(accessProfile.id, [
        { connection: connection("mail", "primary"), tool: ToolName.make("sendEmail") },
        { connection: connection("calendar", "primary"), tool: ToolName.make("createEvent") }
      ])
      yield* gateway.replaceApprovalPolicyTools(approvalPolicy.id, [
        { connection: connection("mail", "primary"), tool: ToolName.make("sendEmail"), decision: "require_approval" },
        { connection: connection("calendar", "primary"), tool: ToolName.make("createEvent"), decision: "allow" },
        { connection: connection("mail", "primary"), tool: ToolName.make("archiveEmail"), decision: "allow" }
      ])
      const { client, key } = yield* createClient(
        gateway, "intersection", accessProfile.id, approvalPolicy.id
      )

      expect(yield* listEffectiveTools(gateway, client.id)).toEqual([
        {
          alias: Alias.make("org_calendar_primary"),
          tool: ToolName.make("createEvent"),
          connection: connection("calendar", "primary"),
          decision: "allow"
        },
        {
          alias: Alias.make("org_mail_primary"),
          tool: ToolName.make("sendEmail"),
          connection: connection("mail", "primary"),
          decision: "require_approval"
        }
      ])
      const authorized = yield* authorizeInvocation(gateway, {
        secret: key.secret, alias: Alias.make("org_mail_primary"), tool: ToolName.make("sendEmail")
      })
      expect(authorized.status).toBe("authorized")
      const calendar = yield* authorizeInvocation(gateway, {
        secret: key.secret, alias: Alias.make("org_calendar_primary"), tool: ToolName.make("createEvent")
      })
      expect(calendar.status).toBe("authorized")
      const outsideApproval = yield* authorizeInvocation(gateway, {
        secret: key.secret, alias: Alias.make("org_mail_primary"), tool: ToolName.make("archiveEmail")
      })
      expect(outsideApproval.status).toBe("not-authorized")
    }).pipe(Effect.provide(testServices)))

  it.effect("changing only the approval policy changes the decision without changing reach", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const accessProfile = yield* gateway.createAccessProfile({
        id: yield* newAccessProfileId, tenantId: defaultTenantId, name: "Mail"
      })
      const approvalPolicy = yield* gateway.createApprovalPolicy({
        id: yield* newApprovalPolicyId, tenantId: defaultTenantId, name: "Mail decisions", tools: []
      })
      const route = { connection: connection("mail", "primary"), tool: ToolName.make("sendEmail") }
      yield* gateway.replaceAccessProfileTools(accessProfile.id, [route])
      yield* gateway.replaceApprovalPolicyTools(approvalPolicy.id, [{ ...route, decision: "allow" }])
      const { client } = yield* createClient(gateway, "decision", accessProfile.id, approvalPolicy.id)
      expect((yield* listEffectiveTools(gateway, client.id))[0]?.decision).toBe("allow")

      yield* gateway.replaceApprovalPolicyTools(approvalPolicy.id, [
        { ...route, decision: "require_approval" }
      ])

      expect((yield* listEffectiveTools(gateway, client.id))[0]?.decision).toBe("require_approval")
    }).pipe(Effect.provide(testServices)))

  it.effect("editing a reusable profile has an explicit shared blast radius", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const accessProfile = yield* gateway.createAccessProfile({
        id: yield* newAccessProfileId, tenantId: defaultTenantId, name: "Shared access"
      })
      const approvalPolicy = yield* gateway.createApprovalPolicy({
        id: yield* newApprovalPolicyId, tenantId: defaultTenantId, name: "Shared decisions", tools: []
      })
      const mail = { connection: connection("mail", "primary"), tool: ToolName.make("sendEmail") }
      const calendar = { connection: connection("calendar", "primary"), tool: ToolName.make("createEvent") }
      yield* gateway.replaceAccessProfileTools(accessProfile.id, [mail])
      yield* gateway.replaceApprovalPolicyTools(approvalPolicy.id, [
        { ...mail, decision: "allow" },
        { ...calendar, decision: "allow" }
      ])
      const alpha = yield* createClient(gateway, "alpha", accessProfile.id, approvalPolicy.id)
      const beta = yield* createClient(gateway, "beta", accessProfile.id, approvalPolicy.id)

      yield* gateway.replaceAccessProfileTools(accessProfile.id, [mail, calendar])

      for (const client of [alpha.client, beta.client]) {
        expect((yield* listEffectiveTools(gateway, client.id)).map((row) => row.tool).sort())
          .toEqual([ToolName.make("createEvent"), ToolName.make("sendEmail")])
      }
    }).pipe(Effect.provide(testServices)))

  it.effect("rejects assigning either reusable configuration across tenants", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const accessProfile = yield* gateway.findDefaultAccessProfile(defaultTenantId)
      const approvalPolicy = yield* gateway.findDefaultApprovalPolicy(defaultTenantId)
      const other = yield* gateway.createTenant({ name: "Other" })
      const otherAccess = yield* gateway.findDefaultAccessProfile(other.id)
      const otherApproval = yield* gateway.findDefaultApprovalPolicy(other.id)
      if (
        accessProfile === undefined || approvalPolicy === undefined ||
        otherAccess === undefined || otherApproval === undefined
      ) {
        throw new Error("missing defaults")
      }
      const { client } = yield* createClient(gateway, "tenant", accessProfile.id, approvalPolicy.id)

      const access = yield* Effect.exit(
        gateway.assignAccessProfile(defaultTenantId, client.id, otherAccess.id)
      )
      const approval = yield* Effect.exit(
        gateway.assignApprovalPolicy(defaultTenantId, client.id, otherApproval.id)
      )

      expect(access._tag).toBe("Failure")
      expect(approval._tag).toBe("Failure")
    }).pipe(Effect.provide(testServices)))
})
