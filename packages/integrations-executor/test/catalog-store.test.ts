import { describe, expect, it } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { CatalogStore } from "../src/catalog-store.ts"
import { memoryLayer } from "../src/database.ts"
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState
} from "../src/ids.ts"

const layer = CatalogStore.layer.pipe(Layer.provide(memoryLayer))

/** Providing the layer also surfaces its own construction failure, so the
 *  helper's error channel widens rather than being asserted away. */
const run = <A, E>(
  operation: Effect.Effect<A, E, CatalogStore>
): Promise<A> => Effect.runPromise(operation.pipe(Effect.provide(layer)))

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
  it("round-trips a record through SQL, JSON columns included", async () => {
    const found = await run(Effect.gen(function* () {
      const store = yield* CatalogStore
      yield* store.putIntegration(integration)
      return yield* store.findIntegration(notes)
    }))
    expect(Option.getOrThrow(found)).toEqual(integration)
  })

  it("upserts rather than duplicating on a second install", async () => {
    const all = await run(Effect.gen(function* () {
      const store = yield* CatalogStore
      yield* store.putIntegration(integration)
      yield* store.putIntegration({ ...integration, name: "Renamed" })
      return yield* store.listIntegrations()
    }))
    expect(all).toHaveLength(1)
    expect(all[0]?.name).toBe("Renamed")
  })

  it("reads an absent slug as absent rather than failing", async () => {
    const found = await run(Effect.gen(function* () {
      const store = yield* CatalogStore
      return yield* store.findIntegration(IntegrationSlug.make("absent"))
    }))
    expect(Option.isNone(found)).toBe(true)
  })
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

  it("keeps an absent optional absent rather than reading back a null", async () => {
    const found = await run(Effect.gen(function* () {
      const store = yield* CatalogStore
      yield* store.putIntegration(integration)
      yield* store.putConnection(connection)
      const rows = yield* store.listConnections({ integration: notes })
      return rows[0]
    }))
    expect(found).toEqual(connection)
    expect(found).not.toHaveProperty("oauthScope")
  })

  it("filters by owner tier, integration and name", async () => {
    const counts = await run(Effect.gen(function* () {
      const store = yield* CatalogStore
      yield* store.putIntegration(integration)
      yield* store.putConnection(connection)
      yield* store.putConnection({
        ...connection,
        owner: "user",
        name: ConnectionName.make("personal")
      })
      return {
        all: (yield* store.listConnections()).length,
        org: (yield* store.listConnections({ owner: "org" })).length,
        named: (yield* store.listConnections({ name: ConnectionName.make("personal") })).length
      }
    }))
    expect(counts).toEqual({ all: 2, org: 1, named: 1 })
  })
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

  it("round-trips a client, arrays included, and holds no secret", async () => {
    const found = await run(Effect.gen(function* () {
      const store = yield* CatalogStore
      yield* store.putOAuthClient(client)
      return yield* store.findOAuthClient({ owner: "org", slug: client.slug })
    }))
    const record = Option.getOrThrow(found)
    expect(record).toEqual(client)
    // The secret lives in the credential store; a database dump is not a spill.
    expect(Object.keys(record)).not.toContain("clientSecret")
  })

  it("spends a state value once, so a replayed callback finds nothing", async () => {
    const outcome = await run(Effect.gen(function* () {
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
      const first = yield* store.takeOAuthFlow(state)
      const second = yield* store.takeOAuthFlow(state)
      return { first: Option.isSome(first), second: Option.isSome(second) }
    }))
    expect(outcome).toEqual({ first: true, second: false })
  })
})

describe("specification documents", () => {
  it("caches a document's text so a restart does not refetch it", async () => {
    const found = await run(Effect.gen(function* () {
      const store = yield* CatalogStore
      yield* store.putSpecDocument("https://example.com/openapi.json", "{\"openapi\":\"3.0.0\"}")
      return yield* store.findSpecDocument("https://example.com/openapi.json")
    }))
    expect(Option.getOrThrow(found)).toBe("{\"openapi\":\"3.0.0\"}")
  })
})
