import type { Integration, McpSurface, Profile } from "@integragents/contracts"
import type { EffectiveTool } from "@integragents/gateway-core"

/** An upstream server's own instructions are passed on, up to this much of each. */
const upstreamInstructionsLimit = 2_000

const clipped = (text: string): string =>
  text.length <= upstreamInstructionsLimit ? text : `${text.slice(0, upstreamInstructionsLimit)}…`

const surfaceGuide = {
  tools:
    "Each tool is named `<connection alias>__<tool>`. A tool whose description says it is held for approval " +
    "waits for a human before it runs; never try to approve it yourself.",
  discovery:
    "Find a tool with `tools`, read its input and output schemas with `schema`, and call it with `execute`. " +
    "A call that comes back pending waits for a human's approval; collect it later with `approval`."
} satisfies Record<McpSurface, string>

/**
 * What an MCP client is told about this server: whose authority it speaks
 * with, how its tools are reached, and each connected integration with the
 * instructions its own server gave.
 */
export const instructionsFor = (
  profile: Profile,
  effective: ReadonlyArray<EffectiveTool>,
  integrations: ReadonlyArray<Integration>
): string => {
  const described = new Map(integrations.map((integration) => [integration.slug, integration]))
  const connections = new Map<string, EffectiveTool["connection"]>()
  for (const tool of effective) connections.set(tool.alias, tool.connection)
  const sections = [...connections].map(([alias, connection]) => {
    const integration = described.get(connection.integration)
    const heading = `## ${integration?.name ?? connection.integration} (${alias})`
    const description = integration?.description.trim() ?? ""
    return description.length === 0 ? heading : `${heading}\n${clipped(description)}`
  })
  return [
    `This is the integrations gateway, calling external services for the profile "${profile.name}". ` +
      "It holds every credential; none ever reaches you.",
    surfaceGuide[profile.mcpSurface],
    "A tool's result arrives as structured content, ready to pass to the next call. Files and media arrive " +
      "inline or as resource links you read with resources/read.",
    ...(sections.length === 0 ? [] : ["# Connected integrations", ...sections])
  ].join("\n\n")
}
