import { formatIntegrationSource } from "@mokronos/wfkit/integrations"
import type { IntegrationSource } from "@mokronos/wfkit/integrations"
import { Schema } from "effect"
import { ExecutorOwner, ExecutorToolAddress } from "./schemas.ts"
import type { ExecutorTools } from "./tools.ts"

/**
 * The outcome of turning a portable `IntegrationSource` into a concrete executor
 * address. Modelled as a union rather than "address or throw" because the two
 * callers want different things from the same walk: `validate` reports every
 * unmet requirement at once, while invocation needs to fail one step.
 *
 * Each failure case carries what a reader needs to fix it — the available tool
 * names, the tiers that are actually connected, the competing addresses — so a
 * colleague's agent can act on `wf validate` output without a second query.
 */
export const IntegrationResolution = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("resolved"),
    address: ExecutorToolAddress,
    owner: ExecutorOwner,
    connection: Schema.String
  }),
  Schema.Struct({ status: Schema.Literal("integration-not-connected") }),
  Schema.Struct({
    status: Schema.Literal("tool-not-found"),
    availableTools: Schema.Array(Schema.String)
  }),
  Schema.Struct({
    status: Schema.Literal("owner-unavailable"),
    requiredOwner: ExecutorOwner,
    availableOwners: Schema.Array(ExecutorOwner)
  }),
  Schema.Struct({
    status: Schema.Literal("ambiguous"),
    candidates: Schema.Array(ExecutorToolAddress)
  }),
  Schema.Struct({
    status: Schema.Literal("legacy-address"),
    address: ExecutorToolAddress
  })
])
export type IntegrationResolution = typeof IntegrationResolution.Type

/** Enough names to identify the miss without turning an error into a catalog
 *  dump; `wf i tools <slug>` is the full listing. */
const availableToolLimit = 20

const distinctOwners = (
  owners: ReadonlyArray<ExecutorOwner>
): ReadonlyArray<ExecutorOwner> => [...new Set(owners)]

/**
 * Resolves a reference against the connections that exist right now.
 *
 * One listing call per integration: the whole candidate set is fetched unfiltered
 * so a miss can be diagnosed (wrong tool name? right tool, wrong tier?) instead
 * of just reported as absent.
 */
export const resolveIntegrationSource = async (
  source: IntegrationSource,
  tools: Pick<ExecutorTools, "summaries">
): Promise<IntegrationResolution> => {
  if ("address" in source) {
    const address = Schema.decodeUnknownSync(ExecutorToolAddress)(source.address)
    const available = await tools.summaries()
    return available.some((tool) => tool.address === address)
      ? { status: "legacy-address", address }
      : { status: "integration-not-connected" }
  }
  const forIntegration = await tools.summaries({ integration: source.integration })
  if (forIntegration.length === 0) {
    return { status: "integration-not-connected" }
  }

  const byName = forIntegration.filter((tool) => tool.name === source.tool)
  if (byName.length === 0) {
    return {
      status: "tool-not-found",
      availableTools: forIntegration.map((tool) => tool.name).sort().slice(0, availableToolLimit)
    }
  }

  // An explicit owner is a constraint, never a preference: falling back to the
  // other tier would run the step against the wrong account.
  const candidates = source.owner === undefined
    ? byName
    : byName.filter((tool) => tool.owner === source.owner)
  if (candidates.length === 0 && source.owner !== undefined) {
    return {
      status: "owner-unavailable",
      requiredOwner: source.owner,
      availableOwners: distinctOwners(byName.map((tool) => tool.owner))
    }
  }

  const [only] = candidates
  if (candidates.length > 1 || only === undefined) {
    return {
      status: "ambiguous",
      candidates: candidates.map((tool) => tool.address).sort()
    }
  }
  return {
    status: "resolved",
    address: only.address,
    owner: only.owner,
    connection: only.connection
  }
}

/** A one-line, actionable rendering of a failed resolution. Ends in the command
 *  that fixes it wherever one exists. */
export const describeIntegrationResolution = (
  source: IntegrationSource,
  resolution: IntegrationResolution
): string => {
  const reference = formatIntegrationSource(source)
  switch (resolution.status) {
    case "resolved":
      return `${reference} resolves to ${resolution.address}`
    case "legacy-address":
      return `${reference} uses a legacy connection-bound address. Re-author it with an integration slug and tool name.`
    case "integration-not-connected":
      return "address" in source
        ? `${reference}: legacy Executor tool address is not available on this machine`
        : `${reference}: no connection for integration "${source.integration}". ` +
          `Connect it with: wf i connect ${source.integration}`
    case "tool-not-found":
      if ("address" in source) return `${reference}: legacy Executor tool address is not available`
      return `${reference}: integration "${source.integration}" is connected but exposes no tool ` +
        `named "${source.tool}". Available: ${resolution.availableTools.join(", ")}. ` +
        `Full listing: wf i tools ${source.integration}`
    case "owner-unavailable":
      if ("address" in source) return `${reference}: legacy Executor tool address is not available`
      return `${reference}: this step requires the "${resolution.requiredOwner}" credential tier, ` +
        `but "${source.tool}" is only connected as ${resolution.availableOwners.join(", ")}. ` +
        // The local host binds a tenant with no subject, so executor's owner
        // policy permits org rows only. Naming a flag that cannot work here
        // would send a reader down a dead end.
        (resolution.requiredOwner === "user"
          ? `The local executor runs without a user subject, so only org connections can exist here — ` +
            `drop the owner pin, or run against a subject-bound executor.`
          : `Connect the ${resolution.requiredOwner} tier before running this workflow.`)
    case "ambiguous": {
      const owners = new Set(resolution.candidates.map((candidate) => candidate.split(".")[2]))
      const [onlyOwner] = [...owners]
      const advice = owners.size > 1
        ? `Pin the tier with owner: "org" or owner: "user" on the step.`
        // An owner pin cannot split two connections that share a tier, so
        // recommending one would be useless advice.
        : `All of them are ${String(onlyOwner)}-owned, so an owner pin cannot separate them — ` +
          `disconnect the ones this workflow should not use.`
      return `${reference}: ${resolution.candidates.length} connections expose this tool ` +
        `(${resolution.candidates.join(", ")}). ${advice}`
    }
  }
}
