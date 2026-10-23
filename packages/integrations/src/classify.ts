import { Effect, Option, Result } from "effect"
import { DiscoveryFailed, serviceName, slugify } from "@integragents/contracts"
import type { EndpointClassification } from "@integragents/contracts"
import type { McpError } from "./errors.ts"
import { McpClient } from "./mcp/client.ts"
import { SpecCache } from "./openapi/cache.ts"

const hostNameOf = (url: string): string =>
  Option.getOrElse(Option.liftThrowable(() => serviceName(new URL(url).hostname))(), () => url)

const asMcp = (url: string): Effect.Effect<EndpointClassification, McpError, McpClient> =>
  Effect.gen(function* () {
    const mcp = yield* McpClient
    const probe = yield* mcp.probe(url)
    const classified: EndpointClassification = {
      kind: "mcp",
      endpoint: url,
      name: probe.name,
      slug: probe.slug,
      probe
    }
    return classified
  })

const asOpenApi = (url: string): Effect.Effect<EndpointClassification, string, SpecCache> =>
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
  }).pipe(Effect.mapError((cause) => cause.detail))

/** Only http(s) URLs are probed; `host/path` or `host:port/path` is a URL with its scheme left out. */
const isHttpUrl = (url: string): boolean => {
  const protocol = URL.parse(url)?.protocol
  return protocol === "http:" || protocol === "https:"
}

export const classify = Effect.fn("Discovery.classify")(function* (url: string) {
  if (!isHttpUrl(url)) {
    return yield* new DiscoveryFailed({ url, reason: url.includes("://") ? "unsupported-scheme" : "no-scheme" })
  }

  const mcp = yield* Effect.result(asMcp(url))
  if (Result.isSuccess(mcp)) return mcp.success

  const openapi = yield* Effect.result(asOpenApi(url))
  if (Result.isSuccess(openapi)) return openapi.success

  const unreachable = mcp.failure.reason === "network" || mcp.failure.reason === "timeout"
  return yield* new DiscoveryFailed({
    url,
    reason: unreachable ? "unreachable" : "not-recognized",
    mcp: mcp.failure.detail,
    openapi: openapi.failure
  })
})
