import { Effect, Option, Result } from "effect"
import { serviceName, slugify } from "@integrations/contracts"
import type { EndpointClassification } from "@integrations/contracts"
import { DetectionError } from "./errors.ts"
import { McpClient } from "./mcp/client.ts"
import { SpecCache } from "./openapi/cache.ts"

const hostNameOf = (url: string): string =>
  Option.getOrElse(
    Option.liftThrowable(() => serviceName(new URL(url).hostname))(),
    () => url
  )

const asMcp = (
  url: string
): Effect.Effect<EndpointClassification, DetectionError, McpClient> =>
  Effect.gen(function* () {
    const mcp = yield* McpClient
    const probe = yield* mcp.probe(url)
    const classified: EndpointClassification = {
      kind: "mcp",
      endpoint: url,
      name: probe.name,
      slug: probe.slug
    }
    return classified
  }).pipe(
    Effect.mapError((cause) => new DetectionError({ url, detail: cause.detail }))
  )

const asOpenApi = (
  url: string
): Effect.Effect<EndpointClassification, DetectionError, SpecCache> =>
  Effect.gen(function* () {
    const specs = yield* SpecCache
    const spec = yield* specs.compileUrl(url)
    const name = Option.getOrElse(spec.title, () => hostNameOf(url))
    const classified: EndpointClassification = {
      kind: "openapi",
      endpoint: url,
      name,
      slug: Option.getOrElse(slugify(name), () => "api")
    }
    return classified
  }).pipe(
    Effect.mapError((cause) => new DetectionError({ url, detail: cause.detail }))
  )

export const classify = Effect.fn("classify")(function* (url: string) {
  const mcp = yield* Effect.result(asMcp(url))
  if (Result.isSuccess(mcp)) return mcp.success

  const openapi = yield* Effect.result(asOpenApi(url))
  if (Result.isSuccess(openapi)) return openapi.success

  return yield* new DetectionError({
    url,
    detail: `it is not an MCP endpoint (${mcp.failure.detail}) `
      + `and not an OpenAPI document (${openapi.failure.detail})`
  })
})
