import { describe, expect, it } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { CatalogStore } from "../src/catalog-store.ts"
import { CredentialStore, connectionCredentialKey } from "../src/credentials.ts"
import { IntegrationHost } from "../src/integration-host.ts"
import { McpHost } from "../src/mcp.ts"
import { OAuthFlows } from "../src/oauth.ts"
import { OpenApiInvoker } from "../src/openapi-invoke.ts"
import { SpecCache } from "../src/spec-cache.ts"
import { stubbedLayer } from "../src/runtime.ts"
import {
  AuthTemplateSlug,
  ConnectionName,
  connectionAddress,
  IntegrationSlug
} from "../src/ids.ts"
import { ExecutorToolAddress as ToolAddress } from "../src/schemas.ts"

/** An MCP host that answers from a fixed catalogue, so the tests exercise this
 *  package's own behaviour rather than a vendor's uptime. */
const stubMcp = (options: {
  readonly readOnly?: boolean
  readonly onCall?: (tool: string, credential: Option.Option<string>) => void
} = {}): Layer.Layer<McpHost> =>
  Layer.effect(
    McpHost,
    Effect.sync(() => ({
      probe: () => Effect.succeed({
        connected: true,
        requiresAuthentication: false,
        requiresOAuth: false,
        supportsDynamicRegistration: false,
        name: "Notes",
        slug: "notes",
        toolCount: 2,
        serverName: "Notes",
        instructions: "A notebook."
      }),
      listTools: () => Effect.succeed([
        {
          name: "search_notes",
          description: "Search the notebook.",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          annotations: { readOnlyHint: options.readOnly ?? true }
        },
        {
          name: "write_note",
          description: "Add a note.",
          inputSchema: { type: "object", properties: { body: { type: "string" } } },
          annotations: { readOnlyHint: false }
        }
      ]),
      callTool: (_endpoint, credential, tool) => {
        options.onCall?.(tool, Option.map(credential, (value) => value.headerValue))
        return Effect.succeed({ content: [{ type: "text", text: `${tool} ran` }] })
      }
    }))
  )

/** Storage in memory, the MCP client stubbed, and everything between them —
 *  addressing, policy, credential resolution — the real implementation. */
const testHost = (mcp: Layer.Layer<McpHost>) =>
  stubbedLayer(Layer.mergeAll(mcp, OpenApiInvoker.layer))

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
      // `readOnly: false` stands in for a server with nothing to declare: an
      // operator can widen a grant, but a call that already happened cannot be
      // narrowed, so this is the direction to fail in.
      stubMcp({ readOnly: false })
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
    expect(both.byName).toBe(both.byAddress)
  })

  it("rejects an address that names no connection it holds", async () => {
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
      expect(outcome.failure._tag).toBe("ConnectionNotFoundError")
    }
  })

  it("cannot be handed an address that is not addressable", () => {
    // The brand refuses it, so an unaddressable string never reaches `execute`
    // in the first place — a stronger guarantee than rejecting it there.
    expect(() => ToolAddress.make("tools.notes.org.primary")).toThrow()
    expect(() => ToolAddress.make("notes.org.primary.search_notes")).toThrow()
  })

  it("surfaces a server-reported tool error as a failure", async () => {
    // An unknown MCP tool is the server's call to reject, not ours: it is
    // authoritative about what it exposes. What matters here is that its
    // refusal becomes a failure rather than a successful result.
    const failing = Layer.effect(
      McpHost,
      Effect.sync(() => ({
        probe: () => Effect.succeed({
          connected: true,
          requiresAuthentication: false,
          requiresOAuth: false,
          supportsDynamicRegistration: false,
          name: "Notes",
          slug: "notes",
          toolCount: 0,
          serverName: "Notes",
          instructions: null
        }),
        listTools: () => Effect.succeed([]),
        callTool: () => Effect.succeed({
          content: [{ type: "text", text: "Unknown tool: absent" }],
          isError: true
        })
      }))
    )
    const outcome = await run(
      Effect.result(Effect.gen(function* () {
        const host = yield* IntegrationHost
        yield* install()
        return yield* host.execute(
          ToolAddress.make("tools.notes.org.primary.absent"),
          {}
        )
      })),
      failing
    )
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag === "Failure") {
      expect(outcome.failure._tag).toBe("InvocationError")
      // The server's own words reach the caller, not a generic message.
      expect(outcome.failure.message).toContain("Unknown tool: absent")
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
