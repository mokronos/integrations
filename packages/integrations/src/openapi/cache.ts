import { Cache, Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { CatalogStore } from "../catalog/store.ts"
import type { IntegrationRecord } from "../catalog/store.ts"
import { describeCause, SpecError } from "../errors.ts"
import { convertGoogleDiscovery, isGoogleDiscoveryUrl } from "./google-discovery.ts"
import { compileSpec } from "./compile.ts"
import type { CompiledSpec } from "./compile.ts"

/** How many compiled specifications to hold in memory at once. */
const capacity = 128

export class SpecCache extends Context.Service<
  SpecCache,
  {
    readonly load: (record: IntegrationRecord) => Effect.Effect<CompiledSpec, SpecError>
    readonly compileUrl: (url: string) => Effect.Effect<CompiledSpec, SpecError>
  }
>()("@integrations/host/SpecCache") {
  static readonly layer: Layer.Layer<
    SpecCache,
    never,
    CatalogStore | HttpClient.HttpClient
  > = Layer.effect(
    SpecCache,
    Effect.gen(function* () {
      const store = yield* CatalogStore
      const client = yield* HttpClient.HttpClient

      const fetchText = Effect.fn("SpecCache.fetchText")((url: string) =>
        client.get(url, {
          headers: { accept: "application/json, application/yaml, text/yaml, */*" }
        }).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
          Effect.mapError((cause) => new SpecError({
            source: url,
            detail: describeCause(cause),
            cause
          }))
        )
      )

      const toOpenApi = (source: string, text: string) =>
        isGoogleDiscoveryUrl(source)
          ? convertGoogleDiscovery(source, text)
          : Effect.succeed(text)

      /** Reads the stored document if we have one, otherwise fetches and stores it. */
      const textOf = Effect.fn("SpecCache.textOf")(function* (source: string) {
        const stored = yield* store.findSpecDocument(source).pipe(
          Effect.mapError((cause) =>
            new SpecError({
              source,
              detail: "Could not read the cached document",
              cause
            })
          )
        )
        return yield* Option.match(stored, {
          onNone: () => fetchText(source).pipe(
            Effect.tap((fetched) =>
              store.putSpecDocument(source, fetched).pipe(Effect.catch((failure) =>
                Effect.logWarning(
                  `Could not cache the specification for ${source}: ${failure.message}`
                ).pipe(Effect.annotateLogs({ source, operation: "SpecCache.putSpecDocument" }))
              ))
            )
          ),
          onSome: Effect.succeed
        })
      })

      const compiled = yield* Cache.make({
        capacity,
        lookup: Effect.fn("SpecCache.compile")(function* (source: string) {
          const openapi = yield* toOpenApi(source, yield* textOf(source))
          return yield* compileSpec(source, openapi)
        })
      })

      /**
       * A Cache holds the lookup's exit, so a failed compile would otherwise
       * stay failed. Dropping the entry keeps a transient fetch error from
       * outliving the request that hit it, while concurrent callers still
       * share the one in-flight lookup.
       */
      const get = (source: string) =>
        Cache.get(compiled, source).pipe(
          Effect.tapError(() => Cache.invalidate(compiled, source))
        )

      const load = Effect.fn("SpecCache.load")(function* (record: IntegrationRecord) {
        const source = record.specSource
        if (source === undefined) {
          return yield* new SpecError({
            source: record.slug,
            detail: "This integration records no specification source"
          })
        }
        return yield* get(source)
      })

      return { load, compileUrl: get }
    })
  )
}
