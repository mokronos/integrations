import { Effect, Option } from "effect"
import { slugify } from "@mokronos/contracts"
import type { EndpointClassification } from "@mokronos/contracts"
import { DetectionError } from "./errors.ts"
import { McpHost } from "./mcp/client.ts"
import { SpecCache } from "./openapi/cache.ts"

/** Deciding what a URL is.
 *
 *  Two questions, asked in order, both of the URL exactly as given: no sibling
 *  path is guessed at and no well-known document is hunted for beyond the one
 *  an MCP handshake itself points at. An `initialize` first, because a server
 *  that answers it — or refuses it with a challenge — is an MCP server;
 *  otherwise the same URL is compiled as an OpenAPI document. A URL that is
 *  neither fails, rather than coming back as a hedge the caller has to rank. */

const hostnameOf = (url: string): string =>
  Option.getOrElse(
    Option.liftThrowable(() => new URL(url).hostname)(),
    () => url
  )

const asMcp = (
  url: string
): Effect.Effect<EndpointClassification, DetectionError, McpHost> =>
  Effect.gen(function* () {
    const mcp = yield* McpHost
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
    const name = Option.getOrElse(spec.title, () => hostnameOf(url))
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

/** Reads the endpoint without installing anything, storing a credential, or
 *  opening a connection. */
export const classify = Effect.fn("classify")(function* (url: string) {
  const mcp = yield* Effect.result(asMcp(url))
  if (mcp._tag === "Success") return mcp.success

  const openapi = yield* Effect.result(asOpenApi(url))
  if (openapi._tag === "Success") return openapi.success

  return yield* new DetectionError({
    url,
    detail: `it is not an MCP endpoint (${mcp.failure.detail}) `
      + `and not an OpenAPI document (${openapi.failure.detail})`
  })
})
