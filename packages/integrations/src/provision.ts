import { Effect, Option, Schema } from "effect"
import { whenPresent } from "@mokronos/contracts"
import { requiresAuthentication } from "./catalog/auth-methods.ts"
import { classify } from "./classify.ts"
import type { McpHost } from "./mcp/client.ts"
import type { SpecCache } from "./openapi/cache.ts"

/** What reading an unknown endpoint needs: an MCP client to try a handshake
 *  with, and the spec cache to try parsing it as OpenAPI. */
type ClassifyServices = McpHost | SpecCache
import { IntegrationHost } from "./host.ts"
import { AuthTemplateSlug } from "./catalog/ids.ts"
import { InvalidInputError } from "./errors.ts"
import type { DetectionError } from "./errors.ts"
import type { HostFailure } from "./host.ts"
import {
  ConnectionName,
  EndpointClassification,
  IntegrationSlug,
  type DiscoverIntegrationsOptions,
  type Integration,
  type IntegrationDiscovery
} from "@mokronos/contracts"

/** Turning a URL into an installed integration.
 *
 *  Classification says what the endpoint is; this makes it permanent: install
 *  it in the catalog, make sure a connection exists, and list what that
 *  connection exposes.
 *
 *  The two refusals here used to be `throw new Error(...)` inside an async
 *  function, so both reached the HTTP layer as an undeclared rejection and were
 *  guessed back into a 400 by reading `cause.message`. */

/** Installs what a classification describes, or hands back what is already
 *  filed under that slug. */
export const installClassified = Effect.fn("Integrations.install")(function*(
  classification: EndpointClassification
): Effect.fn.Return<Integration, HostFailure, IntegrationHost> {
  const host = yield* IntegrationHost
  const decoded = yield* Schema.decodeUnknownEffect(EndpointClassification)(classification).pipe(
    Effect.mapError((cause) => new InvalidInputError({
      field: "classification",
      detail: `Could not read the endpoint classification: ${String(cause)}`
    }))
  )
  const slug = IntegrationSlug.make(decoded.slug)
  const existing = yield* host.findIntegration(slug)
  if (Option.isSome(existing)) {
    // Discovering the same URL twice is idempotent and returns what is already
    // installed. A different URL under a name already taken is not the same
    // act, and handing back the other integration would report success for an
    // endpoint that was never installed.
    if (
      existing.value.displayUrl !== undefined &&
      existing.value.displayUrl !== decoded.endpoint
    ) {
      return yield* new InvalidInputError({
        field: "slug",
        detail: `${decoded.slug} is already installed and points at ${existing.value.displayUrl}. ` +
          `Discover this URL under a different name.`
      })
    }
    return existing.value
  }

  // The auth method is never passed in: installing re-probes the endpoint and
  // derives it from how the server actually refuses, so a caller cannot record
  // a method the server does not offer.
  if (decoded.kind === "mcp") {
    yield* host.addMcp({ endpoint: decoded.endpoint, name: decoded.name, slug })
  } else {
    yield* host.addOpenApi({ spec: decoded.endpoint, slug, name: decoded.name })
  }

  const installed = yield* host.findIntegration(slug)
  if (Option.isNone(installed)) {
    return yield* new InvalidInputError({
      field: "slug",
      detail: `The catalog did not persist integration ${decoded.slug}`
    })
  }
  return installed.value
})

/** What the endpoint said it was, with what the caller decided to call it.
 *
 *  Applied before installing rather than after, because the slug is what the
 *  install is filed under; renaming afterwards would mean moving it. */
const named = (
  classification: EndpointClassification,
  options: DiscoverIntegrationsOptions
): EndpointClassification => ({
  ...classification,
  ...whenPresent("name", options.name),
  ...whenPresent("slug", options.slug)
})

/** A connection for a freshly installed integration, when one can be made
 *  without a human. Answers whether there is now something to list tools for. */
const ensureConnection = Effect.fn("Integrations.ensureConnection")(function*(
  integration: Integration,
  connectionName: ConnectionName
): Effect.fn.Return<boolean, HostFailure, IntegrationHost> {
  const host = yield* IntegrationHost
  const existing = yield* host.listConnections({ integration: integration.slug })
  if (existing.some((connection) => connection.name === connectionName)) return true

  const noAuth = integration.authMethods.find((method) => method.kind === "none")
  if (noAuth === undefined && integration.authMethods.length > 0) return false
  yield* host.createConnection({
    owner: "org",
    integration: integration.slug,
    name: connectionName,
    template: AuthTemplateSlug.make(noAuth?.template ?? "none"),
    value: ""
  })
  return true
})

export const provisionIntegration = Effect.fn("Integrations.provision")(function*(
  url: string,
  options: DiscoverIntegrationsOptions = {}
): Effect.fn.Return<
  IntegrationDiscovery,
  HostFailure | DetectionError,
  IntegrationHost | ClassifyServices
> {
  const host = yield* IntegrationHost
  const classification = named(yield* classify(url), options)
  const integration = yield* installClassified(classification)
  const connectionName = ConnectionName.make(options.connection ?? "default")
  const connected = yield* ensureConnection(integration, connectionName)
  return {
    url,
    classification,
    integration,
    requiresAuthentication: requiresAuthentication(integration.authMethods),
    authMethods: integration.authMethods,
    tools: connected
      ? yield* host.listTools({ integration: integration.slug, connection: connectionName })
      : []
  }
})
