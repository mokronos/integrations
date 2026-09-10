import { describe, expect, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit, Option, Result } from "effect"
import { IntegrationSlug } from "@integrations/contracts"
import { Integrations } from "../src/integrations.ts"
import { SpecError } from "../src/errors.ts"
import type { EndpointClassification, Integration } from "@integrations/contracts"
import { installClassified } from "../src/provision.ts"

const classification: EndpointClassification = {
  kind: "mcp",
  endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
  name: "Gmailmcp",
  slug: "gmailmcp"
}

const installed = (
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

const integrationsWith = (options: {
  readonly existing?: Integration
  readonly added: Array<{ readonly slug: string; readonly name: string }>
}): Context.Context<Integrations> => {
  const dies = (member: string) => () =>
    Effect.die(new Error(`${member} is not used by these tests`))
  return Context.make(Integrations, {
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

const install = (
  classified: typeof classification,
  host: Context.Context<Integrations>
) => Effect.exit(installClassified(classified).pipe(Effect.provide(host)))

describe("provisioning a discovered URL", () => {
  it.effect("installs under the name and slug the caller chose", () =>
    Effect.gen(function*() {
      const added: Array<{ readonly slug: string; readonly name: string }> = []
      const exit = yield* install(
        { ...classification, slug: "gmail", name: "Gmail" },
        integrationsWith({ added })
      )

      expect(added).toEqual([{ slug: "gmail", name: "Gmail" }])
      expect(Exit.isSuccess(exit) && String(exit.value.slug)).toBe("gmail")
    }))

  it.effect("falls back to what the endpoint said it was", () =>
    Effect.gen(function*() {
      const added: Array<{ readonly slug: string; readonly name: string }> = []
      yield* install(classification, integrationsWith({ added }))

      expect(added).toEqual([{ slug: "gmailmcp", name: "Gmailmcp" }])
    }))

  it.effect("is idempotent for the URL already installed under that slug", () =>
    Effect.gen(function*() {
      const added: Array<{ readonly slug: string; readonly name: string }> = []
      const existing = installed({ slug: "gmailmcp", name: "Gmail" })
      const exit = yield* install(classification, integrationsWith({ existing, added }))

      expect(added).toEqual([])
      expect(Exit.isSuccess(exit) && exit.value.name).toBe("Gmail")
    }))

  it.effect("refuses a name already taken by a different endpoint", () =>
    Effect.gen(function*() {
      const added: Array<{ readonly slug: string; readonly name: string }> = []
      const existing = installed({
        slug: "gmail",
        name: "Gmail",
        displayUrl: "https://mail.example.com/mcp"
      })
      const exit = yield* install(
        { ...classification, slug: "gmail" },
        integrationsWith({ existing, added })
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.findError(exit.cause)
        expect(Result.isSuccess(failure) && failure.success._tag).toBe("InvalidInputError")
        expect(Result.isSuccess(failure) && failure.success.message)
          .toContain("https://mail.example.com/mcp")
      }
      expect(added).toEqual([])
    }))
})
