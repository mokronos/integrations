import { Effect, Schema } from "effect"
import { connectionAddress, whenPresent } from "@integragents/contracts"
import { Connection, Integration, Tool, ToolSummary } from "@integragents/contracts"
import type { ConnectionRecord, IntegrationRecord } from "../catalog/store.ts"
import { StorageError } from "../errors.ts"
import type { Tool as IntegrationTool } from "../tool.ts"

const defaultDecision = (readOnly: boolean): "allow" | "require_approval" => (readOnly ? "allow" : "require_approval")

export const toIntegration = (record: IntegrationRecord): Effect.Effect<Integration, StorageError> =>
  Schema.decodeUnknownEffect(Integration)({
    slug: record.slug,
    name: record.name,
    description: record.description,
    kind: record.kind,
    canRemove: true,
    // The host re-registers its own integrations; there is nothing to refresh from.
    canRefresh: record.kind !== "host",
    authMethods: record.authMethods,
    ...whenPresent("displayUrl", record.displayUrl ?? record.endpoint ?? record.specSource)
  }).pipe(
    Effect.mapError((cause) => new StorageError({ message: `Could not describe integration ${record.slug}`, cause }))
  )

export const toConnection = (
  record: ConnectionRecord,
  health: {
    readonly status: "connected" | "reauthorization_required"
    readonly expiresAt?: number
    readonly error?: string
  } = { status: "connected" }
): Effect.Effect<Connection, StorageError> =>
  Schema.decodeUnknownEffect(Connection)({
    owner: record.owner,
    name: record.name,
    integration: record.integration,
    template: record.template,
    address: connectionAddress({
      owner: record.owner,
      integration: record.integration,
      connection: record.name
    }),
    provider: record.provider,
    identityLabel: record.identityLabel ?? null,
    description: record.description ?? null,
    oauthClient: record.oauthClient ?? null,
    oauthClientOwner: record.oauthClientOwner ?? null,
    oauthScope: record.oauthScope ?? null,
    missingOAuthScopes: [],
    expiresAt: health.expiresAt ?? null,
    status: health.status,
    ...whenPresent("error", health.error)
  }).pipe(
    Effect.mapError((cause) => new StorageError({ message: `Could not describe connection ${record.name}`, cause }))
  )

export const toToolSummary = (record: IntegrationTool): Effect.Effect<ToolSummary, StorageError> =>
  Schema.decodeUnknownEffect(ToolSummary)({
    address: record.address,
    name: record.name,
    description: record.description,
    integration: record.integration,
    owner: record.owner,
    connection: record.connection,
    defaultDecision: defaultDecision(record.readOnly),
    readOnly: record.readOnly,
    destructive: record.destructive,
    idempotent: record.idempotent
  }).pipe(Effect.mapError((cause) => new StorageError({ message: `Could not describe tool ${record.name}`, cause })))

export const toTool = (record: IntegrationTool): Effect.Effect<Tool, StorageError> =>
  Effect.flatMap(toToolSummary(record), (summary) =>
    Schema.decodeUnknownEffect(Tool)({
      ...summary,
      ...whenPresent("inputSchema", record.inputSchema),
      ...whenPresent("outputSchema", record.outputSchema)
    }).pipe(Effect.mapError((cause) => new StorageError({ message: `Could not describe tool ${record.name}`, cause })))
  )
