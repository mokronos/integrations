import {
  connectionOwner,
  connectionRefOf,
  connectionResourceUri,
  declaredUi,
  isDelegationTemplate,
  whenPresent,
  whenPresentMap
} from "@integragents/contracts"
import type { Json, SubjectId, ToolAddress, ToolIcon, ToolMeta, ToolSummary, ToolUi } from "@integragents/contracts"
import { Effect, Option } from "effect"
import type { Integrations } from "@integragents/integrations"
import { aliasForConnection } from "../domain.ts"
import type {
  Alias,
  ConnectionName,
  ConnectionRef,
  IntegrationSlug,
  ProfileId,
  ToolDecision,
  ToolName
} from "../domain.ts"
import type { GatewayStoreError, ProfileStore } from "../store/index.ts"
import { boundToolAddress } from "./execute.ts"

export type EffectiveTool = {
  readonly alias: Alias
  readonly tool: ToolName
  readonly connection: ConnectionRef
  readonly decision: ToolDecision
  /** The tool runs on the calling user's own connection; invocations must name a subject. */
  readonly delegated: boolean
  /** What the tool's source says about it; absent when the catalog no longer holds the tool. */
  readonly readOnly?: boolean
  readonly destructive?: boolean
  readonly idempotent?: boolean
  readonly openWorld?: boolean
  readonly title?: string
  readonly description?: string
  readonly inputSchema?: Json
  readonly outputSchema?: Json
  readonly icons?: ReadonlyArray<ToolIcon>
  readonly meta?: ToolMeta
  /** The MCP App its results render in, its view addressed through the gateway. */
  readonly ui?: ToolUi
}

type ToolHints = Pick<ToolSummary, "readOnly" | "destructive" | "idempotent" | "openWorld" | "title">

/** A template names no connection of its own, so any user's connection of that name speaks for its tools. */
const hintKey = (integration: string, owner: string, connection: string, tool: string): string =>
  [integration, owner, connection, tool].join("\u0000")

const hintKeyOf = (connection: ConnectionRef, tool: ToolName): string =>
  hintKey(
    connection.integration,
    isDelegationTemplate(connection) ? "user" : connectionOwner(connection),
    connection.name,
    tool
  )

/**
 * A profile's tools with their decisions. Given the integration host, each one
 * also carries what its source says about it, and its schemas when asked for.
 */
/** A delegated tool acts for the credential's own person, so a credential bound to nobody cannot reach one. */
export const reachableBy =
  (subject: SubjectId | undefined) =>
  (tool: EffectiveTool): boolean =>
    subject !== undefined || !isDelegationTemplate(tool.connection)

export const listEffectiveTools = Effect.fn("Invocation.listEffectiveTools")(function* (
  store: ProfileStore,
  profileId: ProfileId,
  options: {
    readonly schemas?: boolean
    readonly integrations?: Pick<Integrations["Service"], "toolSummaries" | "listConnections" | "describeTool">
    readonly integration?: IntegrationSlug
    readonly connection?: ConnectionName
  } = {}
): Effect.fn.Return<ReadonlyArray<EffectiveTool>, GatewayStoreError> {
  const enabled = (yield* store.listProfileTools(profileId)).filter(
    (profileTool) =>
      (options.integration === undefined || profileTool.connection.integration === options.integration) &&
      (options.connection === undefined || profileTool.connection.name === options.connection)
  )
  const host = options.integrations
  const hints = new Map<string, ToolHints>()
  if (host !== undefined) {
    const summaries = yield* host
      .toolSummaries(whenPresent("integration", options.integration))
      .pipe(
        Effect.catch((failure) =>
          Effect.logWarning(`No tool hints: ${failure.message}`).pipe(Effect.as<ReadonlyArray<ToolSummary>>([]))
        )
      )
    for (const summary of summaries) {
      const hinted: ToolHints = {
        readOnly: summary.readOnly,
        destructive: summary.destructive,
        idempotent: summary.idempotent,
        openWorld: summary.openWorld,
        ...whenPresent("title", summary.title)
      }
      hints.set(hintKey(summary.integration, summary.owner, summary.connection, summary.name), hinted)
      if (summary.owner !== "org")
        hints.set(hintKey(summary.integration, "user", summary.connection, summary.name), hinted)
    }
  }
  const base = enabled.map((profileTool): EffectiveTool => {
    const hinted = hints.get(hintKeyOf(profileTool.connection, profileTool.tool))
    return {
      alias: aliasForConnection(profileTool.connection),
      tool: profileTool.tool,
      connection: profileTool.connection,
      decision: profileTool.decision,
      delegated: isDelegationTemplate(profileTool.connection),
      ...whenPresent("readOnly", hinted?.readOnly),
      ...whenPresent("destructive", hinted?.destructive),
      ...whenPresent("idempotent", hinted?.idempotent),
      ...whenPresent("openWorld", hinted?.openWorld),
      ...whenPresent("title", hinted?.title)
    }
  })
  if (options.schemas !== true || host === undefined) return base

  /** A template names no connection of its own; any held connection of the integration describes the tool. */
  const addressOf = (entry: { readonly connection: ConnectionRef; readonly tool: ToolName }) =>
    isDelegationTemplate(entry.connection)
      ? host.listConnections({ integration: entry.connection.integration }).pipe(
          Effect.map((held) => {
            const sample = held[0]
            return sample === undefined
              ? Option.none<ToolAddress>()
              : Option.some(
                  boundToolAddress(connectionRefOf(sample.owner, sample.integration, sample.name), entry.tool)
                )
          }),
          Effect.catch(() => Effect.succeed(Option.none<ToolAddress>()))
        )
      : Effect.succeed(Option.some(boundToolAddress(entry.connection, entry.tool)))
  const describe = (entry: EffectiveTool, address: ToolAddress) =>
    host.describeTool(address).pipe(
      Effect.map((described) => ({
        ...entry,
        ...whenPresent("title", described.title),
        ...whenPresent("description", described.description),
        ...whenPresent("inputSchema", described.inputSchema),
        ...whenPresent("outputSchema", described.outputSchema),
        ...whenPresent("icons", described.icons),
        ...whenPresent("meta", described.meta),
        ...whenPresentMap("ui", declaredUi(described.meta), (ui) => ({
          ...ui,
          resourceUri: connectionResourceUri(entry.alias, ui.resourceUri)
        }))
      })),
      Effect.catch((failure) =>
        Effect.as(
          Effect.logWarning(`No schema for ${entry.alias}.${entry.tool}: ${failure.message}`).pipe(
            Effect.annotateLogs({
              alias: entry.alias,
              tool: entry.tool,
              operation: "listEffectiveTools.describe"
            })
          ),
          entry
        )
      )
    )
  return yield* Effect.forEach(
    base,
    (entry) =>
      Effect.flatMap(
        addressOf(entry),
        Option.match({
          onNone: () => Effect.succeed(entry),
          onSome: (address) => describe(entry, address)
        })
      ),
    { concurrency: "unbounded" }
  )
})
