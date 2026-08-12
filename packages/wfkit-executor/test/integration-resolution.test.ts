import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { IntegrationSource } from "@mokronos/wfkit"
import {
  describeIntegrationResolution,
  resolveIntegrationSource
} from "../src/integration-resolution.ts"
import { ExecutorToolAddress, ExecutorToolSummary } from "../src/schemas.ts"
import type { ExecutorTools } from "../src/tools.ts"

/** Expected addresses have to carry the brand, same as resolved ones. */
const address = (value: string) => ExecutorToolAddress.make(value)

const summary = (options: {
  readonly integration: string
  readonly owner: "org" | "user"
  readonly connection: string
  readonly name: string
}) =>
  Schema.decodeUnknownSync(ExecutorToolSummary)({
    address: `tools.${options.integration}.${options.owner}.${options.connection}.${options.name}`,
    name: options.name,
    description: `${options.name} description`,
    integration: options.integration,
    owner: options.owner,
    connection: options.connection
  })

/** Stands in for a live executor: `resolveIntegrationSource` only ever reads the
 *  listing, so the whole decision surface is reachable from a fixed catalog. */
const toolsWith = (
  tools: ReadonlyArray<ReturnType<typeof summary>>
): Pick<ExecutorTools, "summaries"> => ({
  summaries: async (filter = {}) =>
    tools.filter((tool) =>
      (filter.integration === undefined || tool.integration === filter.integration) &&
      (filter.owner === undefined || tool.owner === filter.owner) &&
      (filter.connection === undefined || tool.connection === filter.connection)
    )
})

const source = (
  overrides: {
    readonly integration?: string
    readonly tool?: string
    readonly owner?: "org" | "user"
  } = {}
): IntegrationSource => ({
  kind: "executor",
  integration: overrides.integration ?? "linear",
  tool: overrides.tool ?? "createIssue",
  ...(overrides.owner === undefined ? {} : { owner: overrides.owner })
})

const orgDefault = summary({
  integration: "linear",
  owner: "org",
  connection: "default",
  name: "createIssue"
})
const userPersonal = summary({
  integration: "linear",
  owner: "user",
  connection: "personal",
  name: "createIssue"
})

describe("resolveIntegrationSource", () => {
  test("keeps a live legacy address callable for suspended source snapshots", async () => {
    const legacy: IntegrationSource = {
      kind: "executor",
      address: "tools.linear.org.default.createIssue"
    }
    const resolution = await resolveIntegrationSource(legacy, toolsWith([orgDefault]))

    expect(resolution).toEqual({
      status: "legacy-address",
      address: address("tools.linear.org.default.createIssue")
    })
    expect(describeIntegrationResolution(legacy, resolution)).toContain("Re-author")
  })

  test("binds the only connection that exposes the tool", async () => {
    const resolution = await resolveIntegrationSource(source(), toolsWith([orgDefault]))
    expect(resolution).toEqual({
      status: "resolved",
      address: address("tools.linear.org.default.createIssue"),
      owner: "org",
      connection: "default"
    })
  })

  test("reports an unconnected integration with the command that fixes it", async () => {
    const resolution = await resolveIntegrationSource(source(), toolsWith([]))
    expect(resolution.status).toBe("integration-not-connected")
    expect(describeIntegrationResolution(source(), resolution)).toContain("wf i connect linear")
  })

  test("distinguishes a connected integration missing the tool, and names alternatives", async () => {
    const resolution = await resolveIntegrationSource(
      source({ tool: "createIssues" }),
      toolsWith([orgDefault])
    )
    expect(resolution).toEqual({ status: "tool-not-found", availableTools: ["createIssue"] })
  })

  test("resolves a dotted tool name", async () => {
    const dotted = summary({
      integration: "issues",
      owner: "org",
      connection: "default",
      name: "issues.create"
    })
    const resolution = await resolveIntegrationSource(
      source({ integration: "issues", tool: "issues.create" }),
      toolsWith([dotted])
    )
    expect(resolution).toMatchObject({
      status: "resolved",
      address: "tools.issues.org.default.issues.create"
    })
  })

  test("a pinned owner selects its tier instead of reporting ambiguity", async () => {
    const tools = toolsWith([orgDefault, userPersonal])
    await expect(resolveIntegrationSource(source({ owner: "user" }), tools)).resolves.toMatchObject({
      status: "resolved",
      address: "tools.linear.user.personal.createIssue"
    })
    await expect(resolveIntegrationSource(source({ owner: "org" }), tools)).resolves.toMatchObject({
      status: "resolved",
      address: "tools.linear.org.default.createIssue"
    })
  })

  test("a pinned owner fails rather than falling back to the other tier", async () => {
    const resolution = await resolveIntegrationSource(
      source({ owner: "user" }),
      toolsWith([orgDefault])
    )
    expect(resolution).toEqual({
      status: "owner-unavailable",
      requiredOwner: "user",
      availableOwners: ["org"]
    })
    // The local host is org-only, so the advice must not name a connect flag
    // that cannot succeed here.
    const message = describeIntegrationResolution(source({ owner: "user" }), resolution)
    expect(message).toContain("without a user subject")
    expect(message).not.toContain("--owner")
  })

  test("an unpinned reference across two tiers is ambiguous, never a silent pick", async () => {
    const resolution = await resolveIntegrationSource(
      source(),
      toolsWith([orgDefault, userPersonal])
    )
    expect(resolution).toEqual({
      status: "ambiguous",
      candidates: [
        address("tools.linear.org.default.createIssue"),
        address("tools.linear.user.personal.createIssue")
      ]
    })
    expect(describeIntegrationResolution(source(), resolution)).toContain("Pin the tier")
  })

  test("two connections in one tier stay ambiguous, since owner cannot separate them", async () => {
    const staging = summary({
      integration: "linear",
      owner: "org",
      connection: "staging",
      name: "createIssue"
    })
    const resolution = await resolveIntegrationSource(
      source({ owner: "org" }),
      toolsWith([orgDefault, staging])
    )
    expect(resolution.status).toBe("ambiguous")
    // Recommending an owner pin here would be useless: both candidates are org.
    const message = describeIntegrationResolution(source({ owner: "org" }), resolution)
    expect(message).toContain("an owner pin cannot separate them")
    expect(message).toContain("disconnect")
  })
})
