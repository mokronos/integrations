import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { CatalogStore } from "../src/catalog/store.ts"
import { memoryLayer } from "../src/storage/database.ts"
import { AuthTemplateSlug, OAuthClientSlug, OAuthState } from "../src/catalog/ids.ts"
import { ConnectionName, IntegrationSlug } from "@integrations/contracts"

const catalog = CatalogStore.layer.pipe(Layer.provide(memoryLayer))

const notes = IntegrationSlug.make("notes")

const integration = {
  slug: notes,
  name: "Notes",
  description: "A notebook",
  kind: "mcp" as const,
  endpoint: "https://notes.example.com/mcp",
  authMethods: [{
    id: "none",
    label: "No authentication",
    kind: "none" as const,
    template: "none"
  }],
  createdAt: 1
}

describe("integrations", () => {
  it.effect("round-trips a record through SQL, JSON columns included", () =>
    Effect.gen(function*() {
      const store = yield* CatalogStore
      yield* store.putIntegration(integration)

      expect(Option.getOrThrow(yield* store.findIntegration(notes))).toEqual(integration)
    }).pipe(Effect.provide(catalog)))

  it.effect("upserts rather than duplicating on a second install", () =>
    Effect.gen(function*() {
      const store = yield* CatalogStore
      yield* store.putIntegration(integration)
      yield* store.putIntegration({ ...integration, name: "Renamed" })

      const all = yield* store.listIntegrations()
      expect(all).toHaveLength(1)
      expect(all[0]?.name).toBe("Renamed")
    }).pipe(Effect.provide(catalog)))

  it.effect("reads an absent slug as absent rather than failing", () =>
    Effect.gen(function*() {
      const store = yield* CatalogStore

      const found = yield* store.findIntegration(IntegrationSlug.make("absent"))

      expect(Option.isNone(found)).toBe(true)
    }).pipe(Effect.provide(catalog)))
})

describe("connections", () => {
  const connection = {
    owner: "org" as const,
    integration: notes,
    name: ConnectionName.make("primary"),
    template: AuthTemplateSlug.make("none"),
    provider: "local",
    createdAt: 2
  }

  it.effect("keeps an absent optional absent rather than reading back a null", () =>
    Effect.gen(function*() {
      const store = yield* CatalogStore
      yield* store.putIntegration(integration)
      yield* store.putConnection(connection)

      const found = (yield* store.listConnections({ integration: notes }))[0]

      expect(found).toEqual(connection)
      expect(found).not.toHaveProperty("oauthScope")
    }).pipe(Effect.provide(catalog)))

  it.effect("filters by owner tier, integration and name", () =>
    Effect.gen(function*() {
      const store = yield* CatalogStore
      yield* store.putIntegration(integration)
      yield* store.putConnection(connection)
      yield* store.putConnection({
        ...connection,
        owner: "user",
        name: ConnectionName.make("personal")
      })

      expect({
        all: (yield* store.listConnections()).length,
        org: (yield* store.listConnections({ owner: "org" })).length,
        named: (yield* store.listConnections({ name: ConnectionName.make("personal") })).length
      }).toEqual({ all: 2, org: 1, named: 1 })
    }).pipe(Effect.provide(catalog)))
})

describe("OAuth flows", () => {
  const client = {
    owner: "org" as const,
    slug: OAuthClientSlug.make("notes-client"),
    integration: notes,
    clientId: "abc",
    authorizationUrl: "https://auth.example.com/authorize",
    tokenUrl: "https://auth.example.com/token",
    scopes: ["read", "write"],
    tokenAuthMethods: ["client_secret_post"]
  }

  it.effect("round-trips a client, arrays included, and holds no secret", () =>
    Effect.gen(function*() {
      const store = yield* CatalogStore
      yield* store.putOAuthClient(client)

      const found = yield* store.findOAuthClient({ owner: "org", slug: client.slug })

      const record = Option.getOrThrow(found)
      expect(record).toEqual(client)
      expect(Object.keys(record)).not.toContain("clientSecret")
    }).pipe(Effect.provide(catalog)))

  it.effect("spends a state value once, so a replayed callback finds nothing", () =>
    Effect.gen(function*() {
      const store = yield* CatalogStore
      const state = OAuthState.make("state-1")
      yield* store.putOAuthFlow({
        state,
        owner: "org",
        integration: notes,
        connection: ConnectionName.make("primary"),
        template: AuthTemplateSlug.make("oauth2"),
        clientOwner: "org",
        clientSlug: client.slug,
        codeVerifier: "verifier",
        redirectUri: "https://gateway.example.com/callback",
        scopes: ["read"]
      })

      expect(Option.isSome(yield* store.takeOAuthFlow(state))).toBe(true)
      expect(Option.isSome(yield* store.takeOAuthFlow(state))).toBe(false)
    }).pipe(Effect.provide(catalog)))
})
