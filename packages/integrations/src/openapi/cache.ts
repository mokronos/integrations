import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { CatalogStore } from "../catalog/store.ts"
import type { IntegrationRecord } from "../catalog/store.ts"
import { describeCause, SpecError } from "../errors.ts"
import { convertGoogleDiscovery, isGoogleDiscoveryUrl } from "./google-discovery.ts"
import { compileSpec } from "./compile.ts"
import type { CompiledSpec } from "./compile.ts"

export class SpecCache extends Context.Service<
  SpecCache,
  {
    readonly load: (record: IntegrationRecord) => Effect.Effect<CompiledSpec, SpecError>
    readonly compileUrl: (url: string) => Effect.Effect<CompiledSpec, SpecError>
  }
>()("@mokronos/integrations/SpecCache") {
  static readonly layer: Layer.Layer<
    SpecCache,
    never,
    CatalogStore | HttpClient.HttpClient
  > = Layer.effect(
    SpecCache,
    Effect.gen(function* () {
      const store = yield* CatalogStore
      const client = yield* HttpClient.HttpClient
      const compiled = new Map<string, CompiledSpec>()

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

      const compileText = Effect.fn("SpecCache.compileText")(function* (
        source: string,
        text: string
      ) {
        const openapi = yield* toOpenApi(source, text)
        const spec = yield* compileSpec(source, openapi)
        compiled.set(source, spec)
        return spec
      })

      const compileUrl = Effect.fn("SpecCache.compileUrl")(function* (url: string) {
        const held = compiled.get(url)
        if (held !== undefined) return held
        const text = yield* fetchText(url)
        return yield* compileText(url, text)
      })

      const load = Effect.fn("SpecCache.load")(function* (record: IntegrationRecord) {
        const source = record.specSource
        if (source === undefined) {
          return yield* new SpecError({
            source: record.slug,
            detail: "This integration records no specification source"
          })
        }
        const held = compiled.get(source)
        if (held !== undefined) return held

        const stored = yield* store.findSpecDocument(source).pipe(
          Effect.mapError((cause) =>
            new SpecError({
              source,
              detail: "Could not read the cached document",
              cause
            })
          )
        )
        const text = yield* Option.match(stored, {
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
        return yield* compileText(source, text)
      })

      return { load, compileUrl }
    })
  )
}
