import * as Cloudflare from "alchemy/Cloudflare"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { decodeBase64UrlField } from "@integragents/contracts"
import { createGatewayService } from "@integragents/gateway-api"
import { BlobStore } from "@integragents/host"
import {
  createEncryption,
  deliverDueApprovalNotifications,
  runMaintenance
} from "@integragents/gateway-core"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Blobs, r2BlobStore } from "./blobs.ts"

const GatewayEnvironment = Schema.Struct({
  INTEGRATIONS_MASTER_KEY: Schema.String,
  INTEGRATIONS_PUBLIC_URL: Schema.String
})

/**
 * The whole gateway, as one object: its SQLite database is the gateway's
 * database, and requests reach it one at a time, the way they reach the
 * process a local install runs.
 */
export class Gateway extends Cloudflare.DurableObject<Gateway>()(
  "Gateway",
  Effect.gen(function*() {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Blobs)
    const environment = yield* Cloudflare.WorkerEnvironment
    return Effect.gen(function*() {
      const state = yield* Cloudflare.DurableObjectState
      const env = yield* Schema.decodeUnknownEffect(GatewayEnvironment)(environment).pipe(Effect.orDie)
      const masterKey = decodeBase64UrlField("INTEGRATIONS_MASTER_KEY", env.INTEGRATIONS_MASTER_KEY)
      const service = yield* Effect.promise(() =>
        createGatewayService({
          httpClient: FetchHttpClient.layer,
          sqlClient: SqliteClient.layer({ storage: state.raw.storage }),
          blobs: Layer.succeed(BlobStore, r2BlobStore(bucket)),
          encryption: createEncryption(masterKey),
          maintenance: false,
          secureCookies: true
        })
      )
      return {
        fetch: Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          const remoteAddress = request.headers["cf-connecting-ip"]
          const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie)
          const response = yield* Effect.promise(() =>
            service.handle(web, remoteAddress === undefined ? {} : { remoteAddress })
          )
          yield* Effect.promise(() => service.flushTelemetry())
          return HttpServerResponse.fromWeb(response)
        }),
        maintain: () =>
          runMaintenance(service.store).pipe(
            Effect.andThen(deliverDueApprovalNotifications({
              store: service.store,
              dashboardUrl: env.INTEGRATIONS_PUBLIC_URL
            })),
            Effect.withSpan("Maintenance.scheduled"),
            Effect.provide(Layer.merge(FetchHttpClient.layer, service.telemetry)),
            Effect.ensuring(Effect.promise(() => service.flushTelemetry())),
            Effect.orDie
          )
      }
    })
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding))
) {}
