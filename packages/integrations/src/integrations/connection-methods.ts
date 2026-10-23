import { Clock, Effect, Option } from "effect"
import { connectionAddress, InvalidInput, whenPresent } from "@integragents/contracts"
import type { ConnectionName, ConnectionOwner, IntegrationSlug } from "@integragents/contracts"
import { findAuthMethod } from "../catalog/auth-methods.ts"
import { captureMcpTools, captureOpenApiTools } from "../catalog/capture.ts"
import { AuthTemplateSlug, gatewayOAuthClientSlug, OAuthClientSlug } from "../catalog/ids.ts"
import { CatalogStore } from "../catalog/store.ts"
import type { ConnectionRecord, IntegrationRecord } from "../catalog/store.ts"
import { McpClient } from "../mcp/client.ts"
import { OAuthFlows } from "../oauth/flows.ts"
import { SpecCache } from "../openapi/cache.ts"
import type { ResolvedCredential } from "../openapi/invoke.ts"
import { connectionCredentialKey, CredentialStore } from "../storage/credentials.ts"
import { mcpCredential, requireMcpServer } from "./access.ts"
import type { ConnectionAccess } from "./access.ts"
import { toConnection, toTool } from "./views.ts"

export interface CreateConnectionOptions {
  readonly owner: ConnectionOwner
  readonly integration: IntegrationSlug
  readonly name: ConnectionName
  readonly template: AuthTemplateSlug
  readonly value?: string
  readonly values?: Readonly<Record<string, string>>
}

export const connectionMethods = (access: ConnectionAccess) =>
  Effect.gen(function* () {
    const store = yield* CatalogStore
    const credentials = yield* CredentialStore
    const mcp = yield* McpClient
    const oauth = yield* OAuthFlows
    const specs = yield* SpecCache
    const { requireIntegration, requireConnection, resolveCredential } = access

    const listMcpTools = Effect.fn("Integrations.listMcpTools")(function* (
      integration: IntegrationRecord,
      credential: Option.Option<ResolvedCredential>
    ) {
      const listing = yield* mcp.listTools(yield* requireMcpServer(integration), mcpCredential(credential))
      if (integration.mcpEra !== listing.era) {
        yield* store.putIntegration({ ...integration, mcpEra: listing.era })
      }
      return listing.tools
    })

    const captureConnection = Effect.fn("Integrations.captureConnection")(function* (
      integration: IntegrationRecord,
      connection: ConnectionRecord
    ) {
      const credential = yield* resolveCredential(integration, connection)
      const capturedAt = yield* Clock.currentTimeMillis
      const target = {
        owner: connection.owner,
        integration: integration.slug,
        connection: connection.name
      }

      // A host integration's tools come from its registration, not from a server to ask.
      if (integration.kind === "host") {
        return yield* store.listTools({
          integration: integration.slug,
          owner: connection.owner,
          connection: connection.name
        })
      }
      const captured =
        integration.kind === "mcp"
          ? yield* captureMcpTools(target, yield* listMcpTools(integration, credential), capturedAt)
          : yield* captureOpenApiTools(target, yield* specs.load(integration), capturedAt)

      yield* store.replaceTools(
        { owner: connection.owner, integration: integration.slug, name: connection.name },
        captured
      )
      return captured
    })

    const recompileOpenApiTools = Effect.fn("Integrations.recompileOpenApiTools")(function* () {
      const integrations = (yield* store.listIntegrations()).filter((integration) => integration.kind === "openapi")
      yield* Effect.forEach(
        integrations,
        (integration) =>
          Effect.gen(function* () {
            const spec = yield* specs.load(integration)
            const connections = yield* store.listConnections({ integration: integration.slug })
            const capturedAt = yield* Clock.currentTimeMillis
            yield* Effect.forEach(
              connections,
              (connection) =>
                Effect.flatMap(
                  captureOpenApiTools(
                    { owner: connection.owner, integration: integration.slug, connection: connection.name },
                    spec,
                    capturedAt
                  ),
                  (captured) =>
                    store.replaceTools(
                      { owner: connection.owner, integration: integration.slug, name: connection.name },
                      captured
                    )
                ),
              { discard: true }
            )
          }).pipe(
            Effect.catchTag("SpecError", (failure) =>
              Effect.logWarning(`Kept the stored tools for ${integration.slug}: ${failure.message}`)
            )
          ),
        { discard: true }
      )
    })

    const createConnection = Effect.fn("Integrations.createConnection")(function* (options: CreateConnectionOptions) {
      const integration = yield* requireIntegration(options.integration)
      if (integration.kind === "host") {
        return yield* new InvalidInput({
          field: "integration",
          problem: `${integration.slug} is run by its host, which registers its connection itself`
        })
      }
      const method = findAuthMethod(integration.authMethods, options.template)
      if (Option.isNone(method)) {
        return yield* new InvalidInput({
          field: "template",
          problem: `${options.integration} does not offer ${options.template}`
        })
      }

      const address = connectionAddress({
        owner: options.owner,
        integration: options.integration,
        connection: options.name
      })

      const secret = options.values === undefined ? (options.value ?? "") : JSON.stringify(options.values)
      if (secret.length > 0) {
        yield* credentials.set(connectionCredentialKey(address), secret)
      }

      const now = yield* Clock.currentTimeMillis
      const record: ConnectionRecord = {
        owner: options.owner,
        integration: options.integration,
        name: options.name,
        template: options.template,
        provider: "local",
        createdAt: now
      }
      yield* store.putConnection(record)
      yield* captureConnection(integration, record)
      return yield* toConnection(record)
    })

    const refreshConnection = Effect.fn("Integrations.refreshConnection")(function* (reference: {
      readonly owner: ConnectionOwner
      readonly integration: IntegrationSlug
      readonly name: ConnectionName
    }) {
      const integration = yield* requireIntegration(reference.integration)
      const connection = yield* requireConnection(reference)
      const captured = yield* captureConnection(integration, connection)
      return yield* Effect.forEach(captured, toTool)
    })

    const removeConnection = Effect.fn("Integrations.removeConnection")(function* (reference: {
      readonly owner: ConnectionOwner
      readonly integration: IntegrationSlug
      readonly name: ConnectionName
    }) {
      const address = connectionAddress({
        owner: reference.owner,
        integration: reference.integration,
        connection: reference.name
      })
      yield* store.removeConnection(reference)
      yield* credentials.remove(connectionCredentialKey(address))
    })

    return {
      createConnection,
      savedOAuthClientId: Effect.fn("Integrations.savedOAuthClientId")(function* (integration: IntegrationSlug) {
        const client = yield* store.findOAuthClient({
          owner: "org",
          slug: gatewayOAuthClientSlug(integration)
        })
        return Option.map(client, (found) => found.clientId)
      }),
      listConnections: Effect.fn("Integrations.listConnections")(function* (
        filter: {
          readonly integration?: IntegrationSlug
          readonly owner?: ConnectionOwner
        } = {}
      ) {
        const records = yield* store.listConnections(filter)
        return yield* Effect.forEach(
          records,
          (record) => {
            if (record.provider !== "oauth") return toConnection(record)
            const client = record.oauthClient
            const clientOwner = record.oauthClientOwner
            if (client === undefined || clientOwner === undefined) {
              return toConnection(record, {
                status: "reauthorization_required",
                error: `${record.integration}/${record.name} is an OAuth connection with no client recorded`
              })
            }
            return oauth
              .accessToken({
                owner: record.owner,
                integration: record.integration,
                connection: record.name,
                clientOwner,
                client: OAuthClientSlug.make(client)
              })
              .pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      toConnection(record, {
                        status: "reauthorization_required",
                        error: `${record.integration}/${record.name} has no OAuth grant. Connect it again.`
                      }),
                    onSome: (access) =>
                      toConnection(record, {
                        status: "connected",
                        ...whenPresent("expiresAt", access.expiresAt)
                      })
                  })
                ),
                Effect.catch((cause) =>
                  toConnection(record, {
                    status: "reauthorization_required",
                    error: cause.message
                  })
                )
              )
          },
          { concurrency: "unbounded" }
        )
      }),
      removeConnection,
      refreshConnection,
      recompileOpenApiTools
    }
  })
