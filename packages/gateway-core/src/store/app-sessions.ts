import { Context, Effect, Layer, Schema } from "effect"
import { AppContext, AppMessage, AppSessionId, Alias, ProfileId, TenantId, ToolName } from "../domain.ts"
import type { AppSession, Caller, JsonEncodable } from "../domain.ts"
import { CallerColumns, callerArgs, callerOf, Millis } from "./columns.ts"
import { now, operation, StoreSql } from "./sql.ts"
import type { GatewayStoreError } from "./sql.ts"

/** Tool results rendered in their MCP App for a person, kept until they expire. */
export interface AppSessionStore {
  createAppSession(input: {
    readonly id: AppSessionId
    readonly tenantId: TenantId
    readonly profileId: ProfileId
    readonly caller: Caller
    readonly alias: Alias
    readonly tool: ToolName
    readonly arguments: typeof Schema.Json.Type
    readonly result: typeof Schema.Json.Type
    readonly resourceUri: string
    readonly expiresAt: Date
  }): Effect.Effect<void, GatewayStoreError>
  /** The session and the caller that made the call; nothing once it expired. */
  getAppSession(
    tenantId: TenantId,
    id: AppSessionId
  ): Effect.Effect<{ readonly session: AppSession; readonly caller: Caller } | undefined, GatewayStoreError>
  setAppContext(tenantId: TenantId, id: AppSessionId, context: AppContext): Effect.Effect<void, GatewayStoreError>
  addAppMessage(tenantId: TenantId, id: AppSessionId, message: AppMessage): Effect.Effect<void, GatewayStoreError>
  expireAppSessions(now: Date): Effect.Effect<number, GatewayStoreError>
}

/** Messages carry dates, so they are sealed in their JSON form and read back through it. */
const StoredMessages = Schema.toCodecJson(Schema.Array(AppMessage))
const StoredContext = Schema.toCodecJson(AppContext)

const AppSessionRow = Schema.Struct({
  id: AppSessionId,
  tenant_id: TenantId,
  profile_id: ProfileId,
  ...CallerColumns,
  alias: Alias,
  tool: ToolName,
  arguments: Schema.String,
  result: Schema.String,
  resource_uri: Schema.String,
  context: Schema.NullOr(Schema.String),
  messages: Schema.NullOr(Schema.String),
  created_at: Millis,
  expires_at: Millis
})

export class AppSessionStoreService extends Context.Service<AppSessionStoreService, AppSessionStore>()(
  "@integragents/gateway-core/AppSessionStore"
) {
  static readonly layer = Layer.effect(
    AppSessionStoreService,
    Effect.map(StoreSql, (db): AppSessionStore => {
      const sealedJson = (value: JsonEncodable) => db.seal(JSON.stringify(value))
      return {
        createAppSession: (input) =>
          operation(
            "createAppSession",
            Effect.gen(function* () {
              yield* db.run(
                `INSERT INTO gateway_app_session
                   (id, tenant_id, profile_id, api_key_id, oauth_grant_id, oauth_application_id, credential_name, agent,
                    alias, tool, arguments, result, resource_uri, context, messages, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
                [
                  input.id,
                  input.tenantId,
                  input.profileId,
                  ...callerArgs(input.caller),
                  input.alias,
                  input.tool,
                  sealedJson(input.arguments),
                  sealedJson(input.result),
                  input.resourceUri,
                  yield* now,
                  input.expiresAt.getTime()
                ]
              )
            })
          ),

        getAppSession: (tenantId, id) =>
          operation(
            "getAppSession",
            Effect.gen(function* () {
              const row = yield* db.one(
                AppSessionRow,
                "SELECT * FROM gateway_app_session WHERE tenant_id = ? AND id = ? AND expires_at > ?",
                [tenantId, id, yield* now]
              )
              if (row === undefined) return undefined
              const session: AppSession = {
                id: row.id,
                profileId: row.profile_id,
                alias: row.alias,
                tool: row.tool,
                arguments: yield* db.openJson(Schema.Json, row.arguments),
                result: yield* db.openJson(Schema.Json, row.result),
                resourceUri: row.resource_uri,
                createdAt: row.created_at,
                expiresAt: row.expires_at,
                context: row.context === null ? null : yield* db.openJson(StoredContext, row.context),
                messages: row.messages === null ? [] : yield* db.openJson(StoredMessages, row.messages)
              }
              return { session, caller: callerOf(row) }
            })
          ),

        setAppContext: (tenantId, id, context) =>
          operation(
            "setAppContext",
            db.run("UPDATE gateway_app_session SET context = ? WHERE tenant_id = ? AND id = ?", [
              sealedJson(Schema.encodeSync(StoredContext)(context)),
              tenantId,
              id
            ])
          ),

        addAppMessage: (tenantId, id, message) =>
          operation(
            "addAppMessage",
            db.sql.withTransaction(
              Effect.gen(function* () {
                const row = yield* db.one(
                  AppSessionRow,
                  "SELECT * FROM gateway_app_session WHERE tenant_id = ? AND id = ?",
                  [tenantId, id]
                )
                if (row === undefined) return
                const earlier = row.messages === null ? [] : yield* db.openJson(StoredMessages, row.messages)
                yield* db.run("UPDATE gateway_app_session SET messages = ? WHERE tenant_id = ? AND id = ?", [
                  sealedJson(Schema.encodeSync(StoredMessages)([...earlier, message])),
                  tenantId,
                  id
                ])
              })
            )
          ),

        expireAppSessions: (at) =>
          operation(
            "expireAppSessions",
            db.changed("DELETE FROM gateway_app_session WHERE expires_at <= ? RETURNING id", [at.getTime()])
          )
      }
    })
  )
}
