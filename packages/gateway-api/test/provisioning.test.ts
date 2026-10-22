import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { testServices } from "./fixtures.ts"
import { JsonBody, connection, setup, profileWithKey, sendEmailOn } from "./http-support.ts"

describe("provisioning surface", () => {
  it.effect("validates a node that addresses a gateway tool", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        tools: [{ address: "tools.gmail.user:sebastian.work.sendEmail", name: "sendEmail" }]
      })

      const report = yield* call("POST", "/v1/validate", {
        body: { node: { source: { kind: "gateway", alias: "user___sebastian___gmail___work", tool: "sendEmail" } } }
      })

      expect(report.status).toBe(200)
      expect(report.body["ok"]).toBe(true)
      const checks = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ check: Schema.String })))(
        report.body["findings"]
      ).map((finding) => finding.check)
      expect(checks).toEqual(["structural", "authorization", "catalog"])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("reports an alias this key does not hold", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })

      const report = yield* call("POST", "/v1/validate", {
        body: {
          node: { source: { kind: "gateway", alias: "user___sebastian___gmail___work", tool: "deleteEverything" } }
        }
      })

      expect(report.body["ok"]).toBe(false)
      expect(JSON.stringify(report.body)).toContain("not authorized")
    }).pipe(Effect.provide(testServices))
  )

  it.effect("removes a connection by the name it was asked for, not the stored one", () =>
    Effect.gen(function* () {
      const { call, removed } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        connections: [{ integration: "gmail", name: "docs_demo" }]
      })

      const response = yield* call("DELETE", "/v1/connections/gmail/docs-demo")

      expect(response.status).toBe(200)
      expect(response.body["connection"]).toBe("docs_demo")
      expect(removed).toEqual([{ integration: "gmail", name: "docs_demo" }])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("removing an integration takes its connections and the profile tools on them", () =>
    Effect.gen(function* () {
      const { call, store, profile, forgotten } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        connections: [{ integration: "gmail", name: "work" }]
      })

      expect(yield* store.listProfileTools(profile.id)).toHaveLength(1)

      const response = yield* call("DELETE", "/v1/integrations/gmail")

      expect(response.status).toBe(200)
      expect(forgotten).toEqual(["gmail"])
      expect(response.body["connections"]).toEqual(["work"])
      expect(yield* store.listProfileTools(profile.id)).toEqual([])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("renames an integration without moving its slug", () =>
    Effect.gen(function* () {
      const { call, renamed } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        connections: [{ integration: "statelessserver", name: "default" }]
      })

      const response = yield* call("POST", "/v1/integrations/statelessserver/name", {
        body: { name: "Gmail" }
      })

      expect(response.status).toBe(200)
      expect(response.body["name"]).toBe("Gmail")
      expect(response.body["slug"]).toBe("statelessserver")
      expect(renamed).toEqual([{ slug: "statelessserver", name: "Gmail" }])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("refuses to rename or remove an integration it never installed", () =>
    Effect.gen(function* () {
      const { call, renamed, forgotten } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        connections: [{ integration: "gmail", name: "work" }]
      })

      expect(
        (yield* call("POST", "/v1/integrations/notion/name", {
          body: { name: "Notion" }
        })).status
      ).toBe(404)
      expect((yield* call("DELETE", "/v1/integrations/notion")).status).toBe(404)
      expect(renamed).toEqual([])
      expect(forgotten).toEqual([])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("says which connections exist when none matches", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        connections: [{ integration: "gmail", name: "work" }]
      })

      const response = yield* call("DELETE", "/v1/connections/gmail/personal")

      expect(response.status).toBe(404)
      expect(String(response.body["error"])).toContain("work")
    }).pipe(Effect.provide(testServices))
  )

  it.effect("lists a profile's keys by name without their hashes, and revokes one", () =>
    Effect.gen(function* () {
      const { call, profile, key, store } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"]
      })

      const listed = yield* call("GET", `/v1/profiles/${profile.id}/keys`)
      const keys = Schema.decodeUnknownSync(Schema.Array(JsonBody))(listed.body["keys"])
      expect(keys).toMatchObject([{ id: key.id, profileId: profile.id, name: "Claude Desktop" }])
      expect(JSON.stringify(keys)).not.toContain(key.hash)

      const revoked = yield* call("POST", `/v1/keys/${key.id}/revoke`)
      expect(revoked.status).toBe(200)
      const after = yield* store.listApiKeys(profile.id)
      expect(after[0]?.revokedAt).not.toBeNull()
    }).pipe(Effect.provide(testServices))
  )

  it.effect("names the MCP endpoint alongside the profiles, and omits it without a public origin", () =>
    Effect.gen(function* () {
      const named = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        mcpUrl: "https://gateway.example/mcp"
      })
      expect((yield* named.call("GET", "/v1/profiles")).body["mcpUrl"]).toBe("https://gateway.example/mcp")

      const anonymous = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"]
      })
      expect((yield* anonymous.call("GET", "/v1/profiles")).body["mcpUrl"]).toBeUndefined()
    }).pipe(Effect.provide(testServices))
  )

  it.effect("filters and windows the audit trail, and says how much there is", () =>
    Effect.gen(function* () {
      const { call, store, profile } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })
      const other = yield* profileWithKey(store, "other-agent", [sendEmailOn(connection, "allow")])
      yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      yield* call("POST", "/v1/execute", { body: { alias: "user___sebastian___gmail___work", tool: "nope" } })
      yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } },
        secret: other.key.secret
      })

      expect((yield* call("GET", "/v1/audit")).body["total"]).toBe(3)
      const all = yield* call("GET", `/v1/audit?profileId=${profile.id}`)
      expect(all.body["total"]).toBe(2)

      const denied = yield* call("GET", `/v1/audit?profileId=${profile.id}&outcome=denied`)
      expect(denied.body["total"]).toBe(1)
      expect(Schema.decodeUnknownSync(Schema.Array(Schema.Json))(denied.body["records"])).toHaveLength(1)

      const windowed = yield* call("GET", `/v1/audit?profileId=${profile.id}&limit=1&offset=1`)
      expect(windowed.body["total"]).toBe(2)
      expect(windowed.body["offset"]).toBe(1)
      expect(Schema.decodeUnknownSync(Schema.Array(Schema.Json))(windowed.body["records"])).toHaveLength(1)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("refuses a window it cannot read rather than quietly serving another one", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })
      for (const query of ["limit=abc", "limit=0", "limit=1.5", "offset=-1", "since=nope"]) {
        expect((yield* call("GET", `/v1/audit?${query}`)).status).toBe(400)
      }
    }).pipe(Effect.provide(testServices))
  )
})
