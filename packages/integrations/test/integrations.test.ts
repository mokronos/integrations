import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Layer, Option } from "effect"
import { CatalogStore } from "../src/catalog/store.ts"
import {
  CredentialStore,
  connectionCredentialKey,
  writeTokens
} from "../src/storage/credentials.ts"
import { Integrations } from "../src/integrations.ts"
import { McpClient } from "../src/mcp/client.ts"
import { OAuthFlows } from "../src/oauth/flows.ts"
import { OpenApiInvoker } from "../src/openapi/invoke.ts"
import { SpecCache } from "../src/openapi/cache.ts"
import { stubbedLayer } from "../src/runtime.ts"
import { AuthTemplateSlug } from "../src/catalog/ids.ts"
import { ConnectionName, connectionAddress, IntegrationSlug } from "@integrations/contracts"
import { ToolAddress } from "@integrations/contracts"

const stubMcp = (options: {
  readonly readOnly?: boolean
  readonly omitReadOnlyHint?: boolean
  readonly onCall?: (tool: string, credential: Option.Option<string>) => void
  readonly onList?: () => void
} = {}): Layer.Layer<McpClient> =>
  Layer.effect(
    McpClient,
    Effect.sync(() => ({
      probe: () => Effect.succeed({
        connected: true,
        requiresAuthentication: false,
        requiresOAuth: false,
        supportsDynamicRegistration: false,
        scopes: [],
        name: "Notes",
        slug: "notes",
        toolCount: 2,
        serverName: "Notes",
        instructions: "A notebook."
      }),
      listTools: () => {
        options.onList?.()
        const searchNotes = options.omitReadOnlyHint === true
          ? {
              name: "search_notes",
              description: "Search the notebook.",
              inputSchema: { type: "object", properties: { q: { type: "string" } } }
            }
          : {
              name: "search_notes",
              description: "Search the notebook.",
              inputSchema: { type: "object", properties: { q: { type: "string" } } },
              annotations: { readOnlyHint: options.readOnly ?? true }
            }
        return Effect.succeed([
        searchNotes,
        {
          name: "write_note",
          description: "Add a note.",
          inputSchema: { type: "object", properties: { body: { type: "string" } } },
          annotations: { readOnlyHint: false }
        }
      ])
      },
      callTool: (_endpoint, credential, tool) => {
        options.onCall?.(tool, Option.map(credential, (value) => value.headerValue))
        return Effect.succeed({ content: [{ type: "text", text: `${tool} ran` }] })
      }
    }))
  )

const testIntegrations = (mcp: Layer.Layer<McpClient> = stubMcp()) =>
  stubbedLayer(Layer.mergeAll(mcp, OpenApiInvoker.unavailableTestLayer))

/** Names the services a program under test needs, without running it. */
const withIntegrations = <A, E>(
  operation: Effect.Effect<
    A,
    E,
    Integrations | CatalogStore | CredentialStore | McpClient | OAuthFlows | OpenApiInvoker | SpecCache
  >,
  mcp?: Layer.Layer<McpClient>
) => operation.pipe(Effect.provide(testIntegrations(mcp)))

const notes = IntegrationSlug.make("notes")
const primary = ConnectionName.make("primary")

const install = Effect.fn("install")(function* () {
  const host = yield* Integrations
  yield* host.addMcp({
    endpoint: "https://notes.example.com/mcp",
    name: "Notes",
    slug: notes
  })
  return yield* host.createConnection({
    owner: "org",
    integration: notes,
    name: primary,
    template: AuthTemplateSlug.make("none")
  })
})

describe("the catalog", () => {
  it.effect("records what a probe found, and calls it removable", () =>
    Effect.gen(function*() {
      const host = yield* Integrations
      yield* install()
      const integrations = yield* host.listIntegrations()
      expect(integrations).toHaveLength(1)
      expect(String(integrations[0]?.slug)).toBe("notes")
      expect(integrations[0]?.kind).toBe("mcp")
      expect(integrations[0]?.description).toBe("A notebook.")
      expect(integrations[0]?.canRemove).toBe(true)
      expect(integrations[0]?.authMethods[0]?.kind).toBe("none")
    }).pipe(Effect.provide(testIntegrations())))

  it.effect("answers nothing for a slug it does not hold", () =>
    Effect.gen(function*() {
      const host = yield* Integrations
      const found = yield* host.findIntegration(IntegrationSlug.make("absent"))
      expect(Option.isNone(found)).toBe(true)
    }).pipe(Effect.provide(testIntegrations())))

  it.effect("reports an expired OAuth connection without a refresh token as requiring authorization", () =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      const store = yield* CatalogStore
      const credentials = yield* CredentialStore
      yield* store.putIntegration({
        slug: notes,
        name: "Notes",
        description: "A notebook.",
        kind: "mcp",
        endpoint: "https://notes.example.com/mcp",
        authMethods: [{
          id: "oauth2",
          label: "OAuth",
          kind: "oauth",
          template: "oauth2"
        }],
        createdAt: now
      })
      yield* store.putConnection({
        owner: "org",
        integration: notes,
        name: primary,
        template: AuthTemplateSlug.make("oauth2"),
        provider: "oauth",
        oauthClient: "notes-client",
        oauthClientOwner: "org",
        expiresAt: now - 1,
        createdAt: now
      })
      yield* writeTokens(
        credentials,
        connectionCredentialKey(connectionAddress({
          owner: "org",
          integration: notes,
          connection: primary
        })),
        { accessToken: "expired", expiresAt: now - 1 }
      )
      const connections = yield* (yield* Integrations).listConnections()
      const connection = connections[0]

      expect(connection?.status).toBe("reauthorization_required")
      expect(connection?.error).toContain("no refresh token")
    }).pipe(Effect.provide(testIntegrations())))

  it.effect("uses the sealed OAuth grant expiry when reporting connection health", () =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      const tokenExpiry = now + 3_600_000
      const store = yield* CatalogStore
      const credentials = yield* CredentialStore
      yield* store.putIntegration({
        slug: notes,
        name: "Notes",
        description: "A notebook.",
        kind: "mcp",
        endpoint: "https://notes.example.com/mcp",
        authMethods: [{
          id: "oauth2",
          label: "OAuth",
          kind: "oauth",
          template: "oauth2"
        }],
        createdAt: now
      })
      yield* store.putConnection({
        owner: "org",
        integration: notes,
        name: primary,
        template: AuthTemplateSlug.make("oauth2"),
        provider: "oauth",
        oauthClient: "notes-client",
        oauthClientOwner: "org",
        expiresAt: now - 1,
        createdAt: now
      })
      yield* writeTokens(
        credentials,
        connectionCredentialKey(connectionAddress({
          owner: "org",
          integration: notes,
          connection: primary
        })),
        { accessToken: "current", expiresAt: tokenExpiry }
      )
      const connections = yield* (yield* Integrations).listConnections()
      const connection = connections[0]

      expect(connection?.status).toBe("connected")
      expect(connection?.expiresAt).toBe(tokenExpiry)
      expect(connection?.error).toBeUndefined()
    }).pipe(Effect.provide(testIntegrations())))

  it.effect("takes a connection's tools with it when the integration goes", () =>
    Effect.gen(function*() {
      const host = yield* Integrations
      yield* install()
      yield* host.removeIntegration(notes)
      const remaining = yield* host.listConnections()
      expect(remaining).toEqual([])
    }).pipe(Effect.provide(testIntegrations())))

  it.effect("refuses to guess a credential for a template the integration dropped", () =>
    Effect.gen(function*() {
      const outcome = yield* withIntegrations(Effect.result(Effect.gen(function* () {
        const host = yield* Integrations
        const store = yield* CatalogStore
        yield* install()
        const found = yield* store.findIntegration(notes)
        const record = Option.getOrThrow(found)
        yield* store.putIntegration({
          ...record,
          authMethods: [{
            id: "oauth2",
            label: "OAuth",
            kind: "oauth",
            template: "oauth2"
          }]
        })
        return yield* host.refreshConnection({
          owner: "org",
          integration: notes,
          name: primary
        })
      })))
      expect(outcome._tag).toBe("Failure")
      if (outcome._tag === "Failure") {
        expect(outcome.failure._tag).toBe("InvalidInputError")
        if (outcome.failure._tag === "InvalidInputError") {
          expect(outcome.failure.detail).toContain("no longer offers")
        }
      }
    }))

  it.effect("renames an integration without moving what addresses it", () =>
    Effect.gen(function*() {
      const host = yield* Integrations
      yield* install()
      yield* host.renameIntegration(notes, "Field Notes")
      const found = yield* host.findIntegration(notes)
      const connections = yield* host.listConnections()
      const after = {
        name: Option.map(found, (integration) => integration.name),
        addresses: connections.map((connection) => connection.address)
      }
      expect(Option.getOrNull(after.name)).toBe("Field Notes")
      expect(after.addresses).toEqual(["tools.notes.org.primary"])
    }).pipe(Effect.provide(testIntegrations())))

  it.effect("takes the credentials of every connection with it too", () =>
    Effect.gen(function*() {
      const host = yield* Integrations
      const credentials = yield* CredentialStore
      yield* host.addMcp({
        endpoint: "https://notes.example.com/mcp",
        name: "Notes",
        slug: notes
      })
      const address = connectionAddress({ owner: "org", integration: notes, connection: primary })
      yield* host.createConnection({
        owner: "org",
        integration: notes,
        name: primary,
        template: AuthTemplateSlug.make("none"),
        value: "secret"
      })
      const before = yield* credentials.get(connectionCredentialKey(address))
      yield* host.removeIntegration(notes)
      const after = yield* credentials.get(connectionCredentialKey(address))
      const held = { before: Option.isSome(before), after: Option.isSome(after) }
      expect(held).toEqual({ before: true, after: false })
    }).pipe(Effect.provide(testIntegrations())))
})

describe("connections", () => {
  it.effect("refuses a template the integration does not offer", () =>
    Effect.gen(function*() {
      const outcome = yield* withIntegrations(Effect.result(Effect.gen(function* () {
        const host = yield* Integrations
        yield* install()
        return yield* host.createConnection({
          owner: "org",
          integration: notes,
          name: ConnectionName.make("second"),
          template: AuthTemplateSlug.make("bearer")
        })
      })))
      expect(outcome._tag).toBe("Failure")
      if (outcome._tag === "Failure") {
        expect(outcome.failure._tag).toBe("InvalidInputError")
      }
    }))

  it.effect("addresses a connection by owner tier, integration and name", () =>
    Effect.gen(function*() {
      const connection = yield* withIntegrations(install())
      expect(String(connection.address)).toBe("tools.notes.org.primary")
      expect(connection.owner).toBe("org")
    }))

  it.effect("drops the credential with the connection", () =>
    Effect.gen(function*() {
      const host = yield* Integrations
      const credentials = yield* CredentialStore
      yield* host.addMcp({
        endpoint: "https://notes.example.com/mcp",
        name: "Notes",
        slug: notes
      })
      const address = connectionAddress({ owner: "org", integration: notes, connection: primary })
      yield* host.createConnection({
        owner: "org",
        integration: notes,
        name: primary,
        template: AuthTemplateSlug.make("none"),
        value: "secret"
      })
      const before = yield* credentials.get(connectionCredentialKey(address))
      yield* host.removeConnection({ owner: "org", integration: notes, name: primary })
      const after = yield* credentials.get(connectionCredentialKey(address))
      const held = { before: Option.isSome(before), after: Option.isSome(after) }
      expect(held).toEqual({ before: true, after: false })
    }).pipe(Effect.provide(testIntegrations())))
})

describe("tools", () => {
  it.effect("captures once, so listing never reaches the endpoint again", () =>
    Effect.gen(function*() {
      let listings = 0
      const counted = stubMcp({ onList: () => { listings += 1 } })
      const seen = yield* withIntegrations(
        Effect.gen(function* () {
          const host = yield* Integrations
          yield* install()
          const afterConnect = listings
          yield* host.listTools({ integration: notes })
          yield* host.listTools({ integration: notes })
          yield* host.toolSummaries({ integration: notes })
          yield* host.describeTool({ integration: notes, name: "search_notes" })
          return { afterConnect, afterReads: listings }
        }),
        counted
      )
      expect(seen.afterConnect).toBe(1)
      expect(seen.afterReads).toBe(1)
    }))

  it.effect("re-reads the endpoint only when asked to refresh", () =>
    Effect.gen(function*() {
      let listings = 0
      const counted = stubMcp({ onList: () => { listings += 1 } })
      const seen = yield* withIntegrations(
        Effect.gen(function* () {
          const host = yield* Integrations
          yield* install()
          yield* host.refreshConnection({ owner: "org", integration: notes, name: primary })
          return listings
        }),
        counted
      )
      expect(seen).toBe(2)
    }))

  it.effect("drops a tool the upstream stopped exposing", () =>
    Effect.gen(function*() {
      let shrunk = false
      const shrinking = Layer.effect(
        McpClient,
        Effect.sync(() => ({
          probe: () => Effect.succeed({
            connected: true, requiresAuthentication: false, requiresOAuth: false,
            supportsDynamicRegistration: false, scopes: [], name: "Notes", slug: "notes",
            toolCount: 2, serverName: "Notes", instructions: null
          }),
          listTools: () => Effect.succeed(shrunk
            ? [{ name: "search_notes", description: "", annotations: { readOnlyHint: true } }]
            : [
              { name: "search_notes", description: "", annotations: { readOnlyHint: true } },
              { name: "write_note", description: "", annotations: { readOnlyHint: false } }
            ]),
          callTool: () => Effect.succeed({ content: [] })
        }))
      )
      const names = yield* withIntegrations(
        Effect.gen(function* () {
          const host = yield* Integrations
          yield* install()
          const before = (yield* host.toolSummaries({ integration: notes })).length
          shrunk = true
          yield* host.refreshConnection({ owner: "org", integration: notes, name: primary })
          const after = yield* host.toolSummaries({ integration: notes })
          return { before, after: after.map((tool) => String(tool.name)) }
        }),
        shrinking
      )
      expect(names).toEqual({ before: 2, after: ["search_notes"] })
    }))

  it.effect("addresses every tool a connection exposes", () =>
    Effect.gen(function*() {
      const host = yield* Integrations
      yield* install()
      const tools = yield* host.listTools({ integration: notes })
      expect(tools.map((tool) => String(tool.address)).toSorted()).toEqual([
        "tools.notes.org.primary.search_notes",
        "tools.notes.org.primary.write_note"
      ])
    }).pipe(Effect.provide(testIntegrations())))

  it.effect("allows only a tool its own source declares read-only", () =>
    Effect.gen(function*() {
      const host = yield* Integrations
      yield* install()
      const tools = yield* host.toolSummaries({ integration: notes })
      const decisions = Object.fromEntries(tools.map((tool) => [tool.name, tool.defaultDecision]))
      expect(decisions).toEqual({
        search_notes: "allow",
        write_note: "require_approval"
      })
    }).pipe(Effect.provide(testIntegrations())))

  it.effect("requires approval when a source declares no read-only hint at all", () =>
    Effect.gen(function*() {
      const decisions = yield* withIntegrations(
        Effect.gen(function* () {
          const host = yield* Integrations
          yield* install()
          const tools = yield* host.toolSummaries({ integration: notes })
          return tools.map((tool) => tool.defaultDecision)
        }),
        stubMcp({ omitReadOnlyHint: true })
      )
      expect(decisions).toEqual(["require_approval", "require_approval"])
    }))

  it.effect("resolves a tool by integration and name as well as by address", () =>
    Effect.gen(function*() {
      const host = yield* Integrations
      yield* install()
      const byName = yield* host.describeTool({ integration: notes, name: "search_notes" })
      const byAddress = yield* host.describeTool(byName.address)
      const both = { byName: String(byName.address), byAddress: String(byAddress.address) }
      expect(both).toEqual({
        byName: "tools.notes.org.primary.search_notes",
        byAddress: "tools.notes.org.primary.search_notes"
      })
    }).pipe(Effect.provide(testIntegrations())))

  it.effect("rejects an address it holds no tool for", () =>
    Effect.gen(function*() {
      const outcome = yield* withIntegrations(Effect.result(Effect.gen(function* () {
        const host = yield* Integrations
        yield* install()
        return yield* host.execute(
          ToolAddress.make("tools.notes.org.absent.search_notes"),
          {}
        )
      })))
      expect(outcome._tag).toBe("Failure")
      if (outcome._tag === "Failure") {
        expect(outcome.failure._tag).toBe("ToolNotFoundError")
      }
    }))

  it("cannot be handed an address that is not addressable", () => {
    expect(() => ToolAddress.make("tools.notes.org.primary")).toThrow()
    expect(() => ToolAddress.make("notes.org.primary.search_notes")).toThrow()
  })

  it.effect("surfaces a server-reported tool error as a failure", () =>
    Effect.gen(function*() {
      const failing = Layer.effect(
        McpClient,
        Effect.sync(() => ({
          probe: () => Effect.succeed({
            connected: true,
            requiresAuthentication: false,
            requiresOAuth: false,
            supportsDynamicRegistration: false,
            scopes: [],
            name: "Notes",
            slug: "notes",
            toolCount: 0,
            serverName: "Notes",
            instructions: null
          }),
          listTools: () => Effect.succeed([{
            name: "search_notes",
            description: "Search the notebook.",
            annotations: { readOnlyHint: true }
          }]),
          callTool: () => Effect.succeed({
            content: [{ type: "text", text: "the notebook is locked" }],
            isError: true
          })
        }))
      )
      const outcome = yield* withIntegrations(
        Effect.result(Effect.gen(function* () {
          const host = yield* Integrations
          yield* install()
          return yield* host.execute(
            ToolAddress.make("tools.notes.org.primary.search_notes"),
            {}
          )
        })),
        failing
      )
      expect(outcome._tag).toBe("Failure")
      if (outcome._tag === "Failure") {
        expect(outcome.failure._tag).toBe("InvocationError")
        expect(outcome.failure.message).toContain("the notebook is locked")
      }
    }))

  it.effect("unwraps an MCP envelope on the way out", () =>
    Effect.gen(function*() {
      const host = yield* Integrations
      yield* install()
      const out = yield* host.execute(
        ToolAddress.make("tools.notes.org.primary.search_notes"),
        { q: "kitchen" }
      )
      expect(out).toBe("search_notes ran")
    }).pipe(Effect.provide(testIntegrations())))

  it.effect("sends no credential for a connection that needs none", () =>
    Effect.gen(function*() {
      const seen: Array<Option.Option<string>> = []
      yield* withIntegrations(
        Effect.gen(function* () {
          const host = yield* Integrations
          yield* install()
          yield* host.execute(
            ToolAddress.make("tools.notes.org.primary.search_notes"),
            {}
          )
        }),
        stubMcp({ onCall: (_tool, credential) => seen.push(credential) })
      )
      expect(seen).toHaveLength(1)
      expect(Option.isNone(seen[0] ?? Option.none())).toBe(true)
    }))
})
