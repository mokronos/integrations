import { Effect, Option } from "effect"
import { connectionAddress, InvalidInput, NotFound } from "@integragents/contracts"
import { OAuthReconnectRequired } from "@integragents/contracts"
import type { OAuthScopeRequired, ToolCallFailed } from "@integragents/contracts"
import type { ConnectionName, ConnectionOwner, IntegrationSlug } from "@integragents/contracts"
import { findAuthMethod } from "../catalog/auth-methods.ts"
import { OAuthClientSlug } from "../catalog/ids.ts"
import { CatalogStore } from "../catalog/store.ts"
import type { ConnectionRecord, IntegrationRecord } from "../catalog/store.ts"
import type { InvocationError, McpError, OAuthError, SpecError, StorageError } from "../errors.ts"
import type { HostToolError } from "../host-tools.ts"
import type { McpCredential, McpServer } from "../mcp/client.ts"
import { OAuthFlows } from "../oauth/flows.ts"
import type { ResolvedCredential } from "../openapi/invoke.ts"
import { connectionCredentialKey, CredentialStore } from "../storage/credentials.ts"

export type IntegrationFailure =
  | StorageError
  | NotFound
  | InvalidInput
  | InvocationError
  | SpecError
  | McpError
  | OAuthError
  | HostToolError
  | ToolCallFailed
  | OAuthReconnectRequired
  | OAuthScopeRequired

export const requireMcpServer = Effect.fn("Integrations.requireMcpServer")(function* (integration: IntegrationRecord) {
  if (integration.endpoint === undefined) {
    return yield* new InvalidInput({
      field: "integration",
      problem: `${integration.slug} records no MCP endpoint`
    })
  }
  const server: McpServer = {
    endpoint: integration.endpoint,
    era: Option.fromNullishOr(integration.mcpEra)
  }
  return server
})

export const mcpCredential = (credential: Option.Option<ResolvedCredential>): Option.Option<McpCredential> =>
  Option.map(credential, (resolved) => {
    const header = resolved.placements.find((placement) => placement.carrier === "header")
    return header === undefined
      ? { headerName: "Authorization", headerValue: `Bearer ${resolved.value}` }
      : {
          headerName: header.name,
          headerValue: `${header.prefix}${resolved.value}`
        }
  })

export const connectionAccess = Effect.gen(function* () {
  const store = yield* CatalogStore
  const credentials = yield* CredentialStore
  const oauth = yield* OAuthFlows

  const requireIntegration = Effect.fn("Integrations.requireIntegration")(function* (slug: IntegrationSlug) {
    const found = yield* store.findIntegration(slug)
    return yield* Option.match(found, {
      onNone: () => Effect.fail(new NotFound({ resource: "integration", id: slug })),
      onSome: Effect.succeed
    })
  })

  const requireConnection = Effect.fn("Integrations.requireConnection")(function* (reference: {
    readonly owner: ConnectionOwner
    readonly integration: IntegrationSlug
    readonly name: ConnectionName
  }) {
    const found = yield* store.listConnections({
      integration: reference.integration,
      owner: reference.owner,
      name: reference.name
    })
    const record = found[0]
    if (record === undefined) {
      const known = yield* store.listConnections({ integration: reference.integration, owner: reference.owner })
      return yield* new NotFound({
        resource: "connection",
        id: `${reference.integration}/${reference.name}`,
        known: known.map((connection) => connection.name)
      })
    }
    return record
  })

  const resolveCredential = Effect.fn("Integrations.resolveCredential")(function* (
    integration: IntegrationRecord,
    connection: ConnectionRecord,
    renew = false
  ) {
    const method = findAuthMethod(integration.authMethods, connection.template)
    if (Option.isNone(method)) {
      return yield* new InvalidInput({
        field: "connection",
        problem:
          `${connection.integration}/${connection.name} was authorized against the ` +
          `${connection.template} method, which ${connection.integration} no longer offers. ` +
          `Connect it again.`
      })
    }
    const placements = Option.match(method, {
      onNone: () => [],
      onSome: (found) => found.placements ?? []
    })
    const kind = Option.map(method, (found) => found.kind)

    if (Option.exists(kind, (value) => value === "none")) {
      return Option.none<ResolvedCredential>()
    }

    if (Option.exists(kind, (value) => value === "oauth")) {
      const client = connection.oauthClient
      const clientOwner = connection.oauthClientOwner
      if (client === undefined || clientOwner === undefined) {
        return yield* new InvalidInput({
          field: "connection",
          problem: `${connection.integration}/${connection.name} is an OAuth connection with no client recorded`
        })
      }
      const token = yield* oauth.accessToken(
        {
          owner: connection.owner,
          integration: connection.integration,
          connection: connection.name,
          clientOwner,
          client: OAuthClientSlug.make(client)
        },
        { renew }
      )
      return Option.map(token, (access) => ({ value: access.value, placements }))
    }

    const address = connectionAddress({
      owner: connection.owner,
      integration: connection.integration,
      connection: connection.name
    })
    const held = yield* credentials.get(connectionCredentialKey(address))
    return Option.map(held, (value) => ({ value, placements }))
  })

  /**
   * Runs `use` with the connection's credential. An OAuth token the provider
   * rejects is refreshed and tried once more; rejected again, the connection
   * is marked for reconnecting.
   */
  const withCredential = <A>(
    integration: IntegrationRecord,
    connection: ConnectionRecord,
    use: (credential: Option.Option<ResolvedCredential>) => Effect.Effect<A, IntegrationFailure>
  ): Effect.Effect<A, IntegrationFailure> =>
    Effect.gen(function* () {
      const attempt = (renew: boolean) =>
        Effect.result(Effect.flatMap(resolveCredential(integration, connection, renew), use))
      const first = yield* attempt(false)
      if (first._tag === "Success") return first.success
      if (connection.provider !== "oauth" || !rejectsCredential(first.failure)) return yield* first.failure
      const second = yield* attempt(true)
      if (second._tag === "Success") return second.success
      if (!rejectsCredential(second.failure)) return yield* second.failure
      yield* store.requireReconnect(
        { owner: connection.owner, integration: connection.integration, name: connection.name },
        "The provider rejected the connection's token even after a refresh"
      )
      return yield* new OAuthReconnectRequired({ integration: connection.integration, connection: connection.name })
    })

  return { requireIntegration, requireConnection, resolveCredential, withCredential }
})

/** The provider refused the credential itself, before doing anything, so asking again with a fresh token is safe. */
const rejectsCredential = (failure: IntegrationFailure): boolean =>
  (failure._tag === "McpError" && failure.reason === "unauthorized") ||
  (failure._tag === "InvocationError" && failure.status === 401)

export type ConnectionAccess = Effect.Success<typeof connectionAccess>
