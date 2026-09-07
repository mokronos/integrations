import { describe, expect, it } from "bun:test"
import { Cause, Context, Effect, Exit, Option, Result } from "effect"
import { IntegrationSlug } from "@mokronos/contracts"
import { IntegrationHost } from "../src/host.ts"
import { SpecError } from "../src/errors.ts"
import type { EndpointClassification, Integration } from "@mokronos/contracts"
import { installClassified } from "../src/provision.ts"

/** Installing what a URL turned out to be, under the name the caller chose.
 *
 *  The dependencies are hand-built rather than stubbed through the whole host:
 *  what is under test is which name reaches the catalog, so the catalog only
 *  has to record what it was asked for. */

const classification: EndpointClassification = {
  kind: "mcp",
  endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
  name: "Gmailmcp",
  slug: "gmailmcp"
}

const installed = (
  // `slug` stays a plain string here so a fixture reads as one; it is branded
  // on the way out, which is the only place the pattern has to hold.
  overrides: Omit<Partial<Integration>, "slug"> & { readonly slug: string }
): Integration => ({
  name: overrides.slug,
  description: "",
  kind: "mcp",
  canRemove: true,
  canRefresh: true,
  authMethods: [{ id: "none", label: "No authentication", kind: "none", template: "none" }],
  displayUrl: classification.endpoint,
  ...overrides,
  slug: IntegrationSlug.make(overrides.slug)
})

/** The host as installation reaches it. `classify` is not stubbed — these
 *  tests drive `installClassified` with a classification directly, which is
 *  what they were always about. */
const hostWith = (options: {
  readonly existing?: Integration
  readonly added: Array<{ readonly slug: string; readonly name: string }>
}): Context.Context<IntegrationHost> => {
  const dies = (member: string) => () =>
    Effect.die(new Error(`${member} is not used by these tests`))
  return Context.make(IntegrationHost, {
    listIntegrations: dies("listIntegrations"),
    findIntegration: (slug) => {
      if (options.existing !== undefined && options.existing.slug === slug) {
        return Effect.succeed(Option.some(options.existing))
      }
      const added = options.added.find((entry) => entry.slug === slug)
      return Effect.succeed(added === undefined ? Option.none() : Option.some(installed(added)))
    },
    addMcp: (input) => {
      options.added.push({ slug: input.slug, name: input.name ?? input.slug })
      return Effect.succeed(input.slug)
    },
    addOpenApi: () => Effect.fail(new SpecError({
      source: classification.endpoint,
      detail: "not an OpenAPI document"
    })),
    renameIntegration: dies("renameIntegration"),
    removeIntegration: dies("removeIntegration"),
    createConnection: dies("createConnection"),
    listConnections: () => Effect.succeed([]),
    removeConnection: dies("removeConnection"),
    refreshConnection: dies("refreshConnection"),
    toolSummaries: () => Effect.succeed([]),
    listTools: () => Effect.succeed([]),
    describeTool: dies("describeTool"),
    execute: dies("execute")
  })
}

/** Runs an installation against that host, as an `Exit` so a refusal can be
 *  read as the typed failure it now is. */
const install = (
  classified: typeof classification,
  host: Context.Context<IntegrationHost>
) => Effect.runPromiseExit(installClassified(classified).pipe(Effect.provide(host)))

describe("provisioning a discovered URL", () => {
  it("installs under the name and slug the caller chose", async () => {
    const added: Array<{ readonly slug: string; readonly name: string }> = []
    const exit = await install(
      { ...classification, slug: "gmail", name: "Gmail" },
      hostWith({ added })
    )

    expect(added).toEqual([{ slug: "gmail", name: "Gmail" }])
    expect(Exit.isSuccess(exit) && String(exit.value.slug)).toBe("gmail")
  })

  it("falls back to what the endpoint said it was", async () => {
    const added: Array<{ readonly slug: string; readonly name: string }> = []
    await install(classification, hostWith({ added }))

    expect(added).toEqual([{ slug: "gmailmcp", name: "Gmailmcp" }])
  })

  it("is idempotent for the URL already installed under that slug", async () => {
    const added: Array<{ readonly slug: string; readonly name: string }> = []
    const existing = installed({ slug: "gmailmcp", name: "Gmail" })
    const exit = await install(classification, hostWith({ existing, added }))

    // Nothing installed a second time, and the name a human already gave it
    // survives — rediscovery is not a reset.
    expect(added).toEqual([])
    expect(Exit.isSuccess(exit) && exit.value.name).toBe("Gmail")
  })

  it("refuses a name already taken by a different endpoint", async () => {
    const added: Array<{ readonly slug: string; readonly name: string }> = []
    const existing = installed({
      slug: "gmail",
      name: "Gmail",
      displayUrl: "https://mail.example.com/mcp"
    })
    // Returning the other integration here would report success for an
    // endpoint that was never installed. It is a typed refusal now rather than
    // a thrown string the caller had to read a message off.
    const exit = await install(
      { ...classification, slug: "gmail" },
      hostWith({ existing, added })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findError(exit.cause)
      expect(Result.isSuccess(failure) && failure.success._tag).toBe("InvalidInputError")
      expect(Result.isSuccess(failure) && failure.success.message)
        .toContain("https://mail.example.com/mcp")
    }
    expect(added).toEqual([])
  })
})
