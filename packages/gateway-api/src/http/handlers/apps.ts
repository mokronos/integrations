import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { GatewayApi } from "../api.ts"
import { decidedBy, requireProfileCaller, requireTenant } from "../authority.ts"
import {
  appSessionNotes,
  callFromApp,
  readAppSession,
  readFromApp,
  sendAppMessage,
  updateAppContext
} from "../app-sessions.ts"

export const AppsLayer = HttpApiBuilder.group(GatewayApi, "apps", (handlers) =>
  Effect.succeed(
    handlers
      .handle("appSession", (request) =>
        Effect.flatMap(requireTenant, (tenant) => readAppSession(tenant, request.params.id))
      )
      .handle("callFromApp", (request) =>
        Effect.gen(function* () {
          const tenant = yield* requireTenant
          const person = (yield* decidedBy) ?? "a person in the dashboard"
          return yield* callFromApp(tenant, request.params.id, person, {
            name: request.payload.name,
            arguments: request.payload.arguments ?? {}
          })
        })
      )
      .handle("readFromApp", (request) =>
        Effect.gen(function* () {
          const tenant = yield* requireTenant
          return { contents: yield* readFromApp(tenant, request.params.id, request.payload.uri) }
        })
      )
      .handle("appContext", (request) =>
        Effect.gen(function* () {
          yield* updateAppContext(yield* requireTenant, request.params.id, request.payload)
          return {}
        })
      )
      .handle("appMessage", (request) =>
        Effect.gen(function* () {
          yield* sendAppMessage(yield* requireTenant, request.params.id, request.payload.content)
          return {}
        })
      )
      .handle("appNotes", (request) =>
        Effect.gen(function* () {
          const { profile } = yield* requireProfileCaller
          return yield* appSessionNotes(profile, request.params.id)
        })
      )
  )
)
