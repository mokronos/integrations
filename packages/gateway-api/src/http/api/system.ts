import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { GatewayMetadata } from "@integragents/contracts"
import { Authority } from "../middleware.ts"
import { RequiredAccess, Unmetered } from "../identity.ts"

export const SystemGroup = HttpApiGroup.make("system")
  .add(
    HttpApiEndpoint.get("health", "/v1/health", {
      success: Schema.Struct({ ok: Schema.Literal(true) })
    })
      .annotate(Unmetered, true)
      .annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.get("metadata", "/v1/metadata", {
      success: GatewayMetadata
    })
      .annotate(Unmetered, true)
      .annotate(RequiredAccess, "public")
  )
  .middleware(Authority)

export const FallbackGroup = HttpApiGroup.make("fallback")
  .add(
    HttpApiEndpoint.make("GET")("unmatchedGet", "/*", {
      success: Schema.Never.pipe(HttpApiSchema.status(404))
    })
      .annotate(Unmetered, true)
      .annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.make("POST")("unmatchedPost", "/*", {
      success: Schema.Never.pipe(HttpApiSchema.status(404))
    })
      .annotate(Unmetered, true)
      .annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.make("DELETE")("unmatchedDelete", "/*", {
      success: Schema.Never.pipe(HttpApiSchema.status(404))
    })
      .annotate(Unmetered, true)
      .annotate(RequiredAccess, "public")
  )
  .middleware(Authority)
