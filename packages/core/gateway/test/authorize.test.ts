import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  Alias,
  aliasForConnection,
  authorizeInvocation,
  authorizeProfileCapability,
  authorizeProfileInvocation,
  ConnectionName,
  defaultTenantId,
  generateApiKey,
  IntegrationSlug,
  newProfileId,
  SubjectId,
  ToolName
} from "../src/index.ts"
import type { ConnectionRef, GatewayStore } from "../src/index.ts"
import { gatewayStore, testServices } from "./fixtures.ts"

const orgConnection: ConnectionRef = {
  owner: "org",
  integration: IntegrationSlug.make("sharepoint"),
  name: ConnectionName.make("default")
}

const userConnection: ConnectionRef = {
  owner: "user",
  subject: SubjectId.make("sebastian"),
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}

const delegationTemplate: ConnectionRef = {
  owner: "user",
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}

const seed = Effect.fnUntraced(function*(store: GatewayStore, options: {
  readonly capabilities?: ReadonlyArray<"provision_connections" | "administer_gateway">
  readonly connection?: ConnectionRef
  readonly decision?: "allow" | "require_approval"
  readonly name?: string
} = {}) {
  const profile = yield* store.createProfile({
    id: yield* newProfileId,
    tenantId: defaultTenantId,
    name: options.name ?? "support-agent",
    capabilities: options.capabilities ?? ["provision_connections"],
    tools: [{
      connection: options.connection ?? orgConnection,
      tool: ToolName.make("getDocument"),
      decision: options.decision ?? "allow"
    }]
  })
  const key = yield* generateApiKey
  yield* store.addApiKey({ id: key.id, profileId: profile.id, name: "Claude Code", hash: key.hash })
  return { profile, key }
})

const invoke = (
  store: GatewayStore,
  secret: string,
  alias = "org___sharepoint___default",
  tool = "getDocument"
) =>
  authorizeInvocation(store, {
    secret,
    alias: Alias.make(alias),
    tool: ToolName.make(tool)
  })

describe("gateway authorization", () => {
  it.effect("authorizes an enabled tool and names the connection it resolves to", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { profile, key } = yield* seed(store)

      const result = yield* invoke(store, key.secret)

      expect(result.status).toBe("authorized")
      if (result.status !== "authorized") return
      expect(result.profile.id).toBe(profile.id)
      expect(result.connection).toEqual(orgConnection)
      expect(result.subject).toBeNull()
    }).pipe(Effect.provide(testServices)))

  it.effect("derives the human acted for from the connection, not the key", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { key } = yield* seed(store, { connection: userConnection })

      const result = yield* invoke(store, key.secret, "user___sebastian___gmail___work")

      expect(result.status).toBe("authorized")
      if (result.status !== "authorized") return
      expect(result.subject).toBe(SubjectId.make("sebastian"))
    }).pipe(Effect.provide(testServices)))

  it.effect("carries the profile's approval decision through", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { key } = yield* seed(store, { decision: "require_approval" })

      const result = yield* invoke(store, key.secret)

      expect(result.status).toBe("authorized")
      if (result.status !== "authorized") return
      expect(result.decision).toBe("require_approval")
    }).pipe(Effect.provide(testServices)))

  it.effect("rejects an unknown key", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      yield* seed(store)

      expect((yield* invoke(store, "igk_not-a-real-key")).status).toBe("unknown-key")
    }).pipe(Effect.provide(testServices)))

  it.effect("denies every key of a revoked profile", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { profile, key } = yield* seed(store)
      const second = yield* generateApiKey
      yield* store.addApiKey({ id: second.id, profileId: profile.id, name: "Cursor", hash: second.hash })

      yield* store.revokeProfile(defaultTenantId, profile.id)

      expect((yield* invoke(store, key.secret)).status).toBe("profile-revoked")
      expect((yield* invoke(store, second.secret)).status).toBe("profile-revoked")
    }).pipe(Effect.provide(testServices)))

  it.effect("a second live key keeps working while the first is rotated out", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { profile, key } = yield* seed(store)
      const replacement = yield* generateApiKey
      yield* store.addApiKey({ id: replacement.id, profileId: profile.id, name: "Claude Code", hash: replacement.hash })

      yield* store.revokeApiKey(key.id)

      expect((yield* invoke(store, key.secret)).status).toBe("key-revoked")
      expect((yield* invoke(store, replacement.secret)).status).toBe("authorized")
    }).pipe(Effect.provide(testServices)))

  it.effect("denies a tool the profile does not enable, and says no more than it does for an unknown alias", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { key } = yield* seed(store)

      const unauthorizedTool = yield* invoke(store, key.secret, "org___sharepoint___default", "deleteDocument")
      const unknownAlias = yield* invoke(store, key.secret, "nothing_here", "getDocument")

      expect(unauthorizedTool.status).toBe("not-authorized")
      expect(unknownAlias.status).toBe(unauthorizedTool.status)
    }).pipe(Effect.provide(testServices)))

  it.effect("turning a tool off denies it while leaving another tool usable", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { profile, key } = yield* seed(store)
      yield* store.replaceProfileTools(profile.id, [
        { connection: orgConnection, tool: ToolName.make("getDocument"), decision: "allow" },
        { connection: userConnection, tool: ToolName.make("search"), decision: "allow" }
      ])

      yield* store.replaceProfileTools(profile.id, [
        { connection: userConnection, tool: ToolName.make("search"), decision: "allow" }
      ])

      expect((yield* invoke(store, key.secret)).status).toBe("not-authorized")
      expect((yield* invoke(store, key.secret, "user___sebastian___gmail___work", "search")).status)
        .toBe("authorized")
    }).pipe(Effect.provide(testServices)))

  it.effect("two profiles decide the same tool independently", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { key: readerKey } = yield* seed(store, { name: "reader" })
      const { key: writerKey } = yield* seed(store, { name: "sales-campaign", decision: "require_approval" })

      const reader = yield* invoke(store, readerKey.secret)
      const campaign = yield* invoke(store, writerKey.secret)

      expect(reader.status).toBe("authorized")
      expect(campaign.status).toBe("authorized")
      if (reader.status !== "authorized" || campaign.status !== "authorized") return
      expect(reader.decision).toBe("allow")
      expect(campaign.decision).toBe("require_approval")
    }).pipe(Effect.provide(testServices)))

  it.effect("the tenant's connection and one person's own never share an alias", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { profile, key } = yield* seed(store)
      const shared = {
        owner: "org",
        integration: IntegrationSlug.make("gmail"),
        name: ConnectionName.make("work")
      } as const
      expect(aliasForConnection(shared)).not.toBe(aliasForConnection(userConnection))

      yield* store.replaceProfileTools(profile.id, [
        { connection: shared, tool: ToolName.make("sendEmail"), decision: "allow" },
        { connection: userConnection, tool: ToolName.make("sendEmail"), decision: "require_approval" }
      ])

      const tenant = yield* invoke(store, key.secret, aliasForConnection(shared), "sendEmail")
      const personal = yield* invoke(store, key.secret, aliasForConnection(userConnection), "sendEmail")

      expect(tenant.status).toBe("authorized")
      expect(personal.status).toBe("authorized")
      if (tenant.status !== "authorized" || personal.status !== "authorized") return
      expect(tenant.connection).toEqual(shared)
      expect(tenant.subject).toBeNull()
      expect(tenant.decision).toBe("allow")
      expect(personal.connection).toEqual(userConnection)
      expect(personal.subject).toBe(SubjectId.make("sebastian"))
      expect(personal.decision).toBe("require_approval")
    }).pipe(Effect.provide(testServices)))

  it.effect("records when a key was last used", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { profile, key } = yield* seed(store)
      expect((yield* store.listApiKeys(profile.id))[0]?.lastUsedAt).toBeNull()

      yield* invoke(store, key.secret)

      expect((yield* store.listApiKeys(profile.id))[0]?.lastUsedAt).not.toBeNull()
    }).pipe(Effect.provide(testServices)))
})

describe("delegated tools", () => {
  it.effect("a template tool resolves to the calling subject's own connection", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { profile } = yield* seed(store, { connection: delegationTemplate })

      const result = yield* authorizeProfileInvocation(store, profile, {
        alias: aliasForConnection(delegationTemplate),
        tool: ToolName.make("getDocument"),
        subject: SubjectId.make("sebastian")
      })

      expect(aliasForConnection(delegationTemplate)).toBe("user___gmail___work")
      expect(result.status).toBe("authorized")
      if (result.status !== "authorized") return
      expect(result.connection).toEqual(userConnection)
      expect(result.subject).toBe(SubjectId.make("sebastian"))
      expect(result.profileTool.connection).toEqual(delegationTemplate)
    }).pipe(Effect.provide(testServices)))

  it.effect("refuses a template tool when the call names nobody", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { profile } = yield* seed(store, { connection: delegationTemplate })

      const result = yield* authorizeProfileInvocation(store, profile, {
        alias: aliasForConnection(delegationTemplate),
        tool: ToolName.make("getDocument")
      })

      expect(result.status).toBe("not-authorized")
      if (result.status !== "not-authorized") return
      expect(result.message).toContain("subject")
    }).pipe(Effect.provide(testServices)))

  it.effect("a subject does not turn a concrete tool into someone else's connection", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { profile } = yield* seed(store, { connection: userConnection })

      const result = yield* authorizeProfileInvocation(store, profile, {
        alias: aliasForConnection(userConnection),
        tool: ToolName.make("getDocument"),
        subject: SubjectId.make("someone-else")
      })

      expect(result.status).toBe("authorized")
      if (result.status !== "authorized") return
      expect(result.connection).toEqual(userConnection)
    }).pipe(Effect.provide(testServices)))
})

describe("gateway capability authorization", () => {
  it.effect("permits a key whose profile holds the requested capability", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { key } = yield* seed(store, {
        capabilities: ["provision_connections", "administer_gateway"]
      })

      expect((yield* authorizeProfileCapability(store, key.secret, "administer_gateway")).status)
        .toBe("authorized")
    }).pipe(Effect.provide(testServices)))

  it.effect("refuses a key whose profile may not, before any human is asked", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { key } = yield* seed(store, { capabilities: ["provision_connections"] })

      expect((yield* authorizeProfileCapability(store, key.secret, "administer_gateway")).status)
        .toBe("not-permitted")
    }).pipe(Effect.provide(testServices)))

  it.effect("refuses unknown and revoked credentials", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { profile, key } = yield* seed(store, {
        capabilities: ["provision_connections", "administer_gateway"]
      })

      expect((yield* authorizeProfileCapability(store, "igk_nope", "administer_gateway")).status)
        .toBe("unknown-key")

      yield* store.revokeProfile(defaultTenantId, profile.id)
      expect((yield* authorizeProfileCapability(store, key.secret, "administer_gateway")).status)
        .toBe("profile-revoked")
    }).pipe(Effect.provide(testServices)))
})
