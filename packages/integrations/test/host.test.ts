import { describe, expect, it } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { CatalogStore } from "../src/catalog/store.ts"
import { CredentialStore, connectionCredentialKey } from "../src/storage/credentials.ts"
import { IntegrationHost } from "../src/host.ts"
import { McpHost } from "../src/mcp/client.ts"
import { OAuthFlows } from "../src/oauth/flows.ts"
import { OpenApiInvoker } from "../src/openapi/invoke.ts"
import { SpecCache } from "../src/openapi/cache.ts"
import { stubbedLayer } from "../src/runtime.ts"
import { AuthTemplateSlug } from "../src/catalog/ids.ts"
import { ConnectionName, connectionAddress, IntegrationSlug } from "@mokronos/contracts"
import { ToolAddress } from "@mokronos/contracts"

/** An MCP host that answers from a fixed catalogue, so the tests exercise this
 *  package's own behaviour rather than a vendor's uptime. */
const stubMcp = (options: {
  readonly readOnly?: boolean
  readonly omitReadOnlyHint?: boolean
  readonly onCall?: (tool: string, credential: Option.Option<string>) => void
  readonly onList?: () => void
} = {}): Layer.Layer<McpHost> =>
  Layer.effect(
    McpHost,
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

/** Storage in memory, the MCP client stubbed, and everything between them —
 *  addressing, policy, credential resolution — the real implementation. */
const testHost = (mcp: Layer.Layer<McpHost>) =>
  stubbedLayer(Layer.mergeAll(mcp, OpenApiInvoker.unavailableTestLayer))

const run = <A, E>(
  operation: Effect.Effect<
    A,
    E,
    IntegrationHost | CatalogStore | CredentialStore | McpHost | OAuthFlows | OpenApiInvoker | SpecCache
  >,
  mcp: Layer.Layer<McpHost> = stubMcp()
): Promise<A> =>
  Effect.runPromise(operation.pipe(Effect.provide(testHost(mcp))))

const notes = IntegrationSlug.make("notes")
const primary = ConnectionName.make("primary")

const install = Effect.fn("install")(function* () {
  const host = yield* IntegrationHost
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
  it("records what a probe found, and calls it removable", async () => {
    const integrations = await run(Effect.gen(function* () {
      const host = yield* IntegrationHost
      yield* install()
      return yield* host.listIntegrations()
    }))
    expect(integrations).toHaveLength(1)
    expect(String(integrations[0]?.slug)).toBe("notes")
    expect(integrations[0]?.kind).toBe("mcp")
    expect(integrations[0]?.description).toBe("A notebook.")
    expect(integrations[0]?.canRemove).toBe(true)
    expect(integrations[0]?.authMethods[0]?.kind).toBe("none")
  })

  it("answers nothing for a slug it does not hold", async () => {
    const found = await run(Effect.gen(function* () {
      const host = yield* IntegrationHost
      return yield* host.findIntegration(IntegrationSlug.make("absent"))
    }))
    expect(Option.isNone(found)).toBe(true)
  })

  it("takes a connection's tools with it when the integration goes", async () => {
    const remaining = await run(Effect.gen(function* () {
      const host = yield* IntegrationHost
      yield* install()
      yield* host.removeIntegration(notes)
      return yield* host.listConnections()
    }))
    expect(remaining).toEqual([])
  })

  it("refuses to guess a credential for a template the integration dropped", async () => {
    // A vendor that adds a wall re-probes into different auth methods, and the
    // connection made under the old one now names nothing. The branch below
    // this one presents whatever is stored under the connection's key, which
    // for an OAuth connection is the sealed token record — so guessing here
    // sends a bearer token made of JSON and reads back as a bad credential.
    const outcome = await run(Effect.result(Effect.gen(function* () {
      const host = yield* IntegrationHost
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
  })

  it("renames an integration without moving what addresses it", async () => {
    const after = await run(Effect.gen(function* () {
      const host = yield* IntegrationHost
      yield* install()
      yield* host.renameIntegration(notes, "Field Notes")
      const found = yield* host.findIntegration(notes)
      const connections = yield* host.listConnections()
      return {
        name: Option.map(found, (integration) => integration.name),
        addresses: connections.map((connection) => connection.address)
      }
    }))
    expect(Option.getOrNull(after.name)).toBe("Field Notes")
    // The slug is the identity, so every address stays exactly where it was.
    expect(after.addresses).toEqual(["tools.notes.org.primary"])
  })

  it("takes the credentials of every connection with it too", async () => {
    // The catalog's cascade is SQL and a sealed credential is not in the
    // database, so removing the integration has to go out through the
    // connection path or the row goes and the secret stays.
    const held = await run(Effect.gen(function* () {
      const host = yield* IntegrationHost
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
      return { before: Option.isSome(before), after: Option.isSome(after) }
    }))
    expect(held).toEqual({ before: true, after: false })
  })
})

describe("connections", () => {
  it("refuses a template the integration does not offer", async () => {
    const outcome = await run(Effect.result(Effect.gen(function* () {
      const host = yield* IntegrationHost
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
  })

  it("addresses a connection by owner tier, integration and name", async () => {
    const connection = await run(install())
    expect(String(connection.address)).toBe("tools.notes.org.primary")
    expect(connection.owner).toBe("org")
  })

  it("drops the credential with the connection", async () => {
    const held = await run(Effect.gen(function* () {
      const host = yield* IntegrationHost
      const credentials = yield* CredentialStore
      yield* host.addMcp({
        endpoint: "https://notes.example.com/mcp",
        name: "Notes",
        slug: notes
      })
      // A `none` template is the only one this integration offers, so the
      // credential is written directly to prove removal clears it.
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
      return { before: Option.isSome(before), after: Option.isSome(after) }
    }))
    expect(held).toEqual({ before: true, after: false })
  })
})

describe("tools", () => {
  it("captures once, so listing never reaches the endpoint again", async () => {
    // This is the point of storing tools: opening a dashboard used to be one
    // `tools/list` round trip per connection.
    let listings = 0
    const counted = stubMcp({ onList: () => { listings += 1 } })
    const seen = await run(
      Effect.gen(function* () {
        const host = yield* IntegrationHost
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
  })

  it("re-reads the endpoint only when asked to refresh", async () => {
    let listings = 0
    const counted = stubMcp({ onList: () => { listings += 1 } })
    const seen = await run(
      Effect.gen(function* () {
        const host = yield* IntegrationHost
        yield* install()
        yield* host.refreshConnection({ owner: "org", integration: notes, name: primary })
        return listings
      }),
      counted
    )
    expect(seen).toBe(2)
  })

  it("drops a tool the upstream stopped exposing", async () => {
    // Replacing rather than merging is what makes a withdrawn tool disappear.
    let shrunk = false
    const shrinking = Layer.effect(
      McpHost,
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
    const names = await run(
      Effect.gen(function* () {
        const host = yield* IntegrationHost
        yield* install()
        const before = (yield* host.toolSummaries({ integration: notes })).length
        shrunk = true
        yield* host.refreshConnection({ owner: "org", integration: notes, name: primary })
        const after = yield* host.toolSummaries({ integration: notes })
        return { before, after: after.map((tool) => tool.name) }
      }),
      shrinking
    )
    expect(names).toEqual({ before: 2, after: ["search_notes"] })
  })

  it("addresses every tool a connection exposes", async () => {
    const tools = await run(Effect.gen(function* () {
      const host = yield* IntegrationHost
      yield* install()
      return yield* host.listTools({ integration: notes })
    }))
    expect(tools.map((tool) => String(tool.address)).toSorted()).toEqual([
      "tools.notes.org.primary.search_notes",
      "tools.notes.org.primary.write_note"
    ])
  })

  it("allows only a tool its own source declares read-only", async () => {
    const decisions = await run(Effect.gen(function* () {
      const host = yield* IntegrationHost
      yield* install()
      const tools = yield* host.toolSummaries({ integration: notes })
      return Object.fromEntries(tools.map((tool) => [tool.name, tool.defaultDecision]))
    }))
    expect(decisions).toEqual({
      search_notes: "allow",
      write_note: "require_approval"
    })
  })

  it("requires approval when a source declares no read-only hint at all", async () => {
    const decisions = await run(
      Effect.gen(function* () {
        const host = yield* IntegrationHost
        yield* install()
        const tools = yield* host.toolSummaries({ integration: notes })
        return tools.map((tool) => tool.defaultDecision)
      }),
      stubMcp({ omitReadOnlyHint: true })
    )
    expect(decisions).toEqual(["require_approval", "require_approval"])
  })

  it("resolves a tool by integration and name as well as by address", async () => {
    const both = await run(Effect.gen(function* () {
      const host = yield* IntegrationHost
      yield* install()
      const byName = yield* host.describeTool({ integration: notes, name: "search_notes" })
      const byAddress = yield* host.describeTool(byName.address)
      return { byName: String(byName.address), byAddress: String(byAddress.address) }
    }))
    expect(both).toEqual({
      byName: "tools.notes.org.primary.search_notes",
      byAddress: "tools.notes.org.primary.search_notes"
    })
  })

  it("rejects an address it holds no tool for", async () => {
    const outcome = await run(Effect.result(Effect.gen(function* () {
      const host = yield* IntegrationHost
      yield* install()
      return yield* host.execute(
        ToolAddress.make("tools.notes.org.absent.search_notes"),
        {}
      )
    })))
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag === "Failure") {
      // Tools are captured, so an address that was never captured is unknown
      // here rather than being forwarded to an endpoint to reject.
      expect(outcome.failure._tag).toBe("ToolNotFoundError")
    }
  })

  it("cannot be handed an address that is not addressable", () => {
    // The brand refuses it, so an unaddressable string never reaches `execute`
    // in the first place — a stronger guarantee than rejecting it there.
    expect(() => ToolAddress.make("tools.notes.org.primary")).toThrow()
    expect(() => ToolAddress.make("notes.org.primary.search_notes")).toThrow()
  })

  it("surfaces a server-reported tool error as a failure", async () => {
    // A server that refuses a call it does expose must produce a failure, not a
    // successful result carrying an error payload.
    const failing = Layer.effect(
      McpHost,
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
    const outcome = await run(
      Effect.result(Effect.gen(function* () {
        const host = yield* IntegrationHost
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
      // The server's own words reach the caller, not a generic message.
      expect(outcome.failure.message).toContain("the notebook is locked")
    }
  })

  it("unwraps an MCP envelope on the way out", async () => {
    const out = await run(Effect.gen(function* () {
      const host = yield* IntegrationHost
      yield* install()
      return yield* host.execute(
        ToolAddress.make("tools.notes.org.primary.search_notes"),
        { q: "kitchen" }
      )
    }))
    expect(out).toBe("search_notes ran")
  })

  it("sends no credential for a connection that needs none", async () => {
    const seen: Array<Option.Option<string>> = []
    await run(
      Effect.gen(function* () {
        const host = yield* IntegrationHost
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
  })
})
