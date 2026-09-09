import { Effect, Option, Schema } from "effect"
import { whenPresent } from "@integrations/contracts"
import { requiresAuthentication } from "./catalog/auth-methods.ts"
import { classify } from "./classify.ts"
import type { McpClient } from "./mcp/client.ts"
import type { SpecCache } from "./openapi/cache.ts"

type ClassifyServices = McpClient | SpecCache
import { Integrations } from "./integrations.ts"
import { AuthTemplateSlug } from "./catalog/ids.ts"
import { InvalidInputError } from "./errors.ts"
import type { DetectionError } from "./errors.ts"
import type { IntegrationFailure } from "./integrations.ts"
import {
  ConnectionName,
  EndpointClassification,
  IntegrationSlug,
  type DiscoverIntegrationsOptions,
  type Integration,
  type IntegrationDiscovery
} from "@integrations/contracts"

export const installClassified = Effect.fn("Integrations.install")(function*(
  classification: EndpointClassification
): Effect.fn.Return<Integration, IntegrationFailure, Integrations> {
  const host = yield* Integrations
  const decoded = yield* Schema.decodeUnknownEffect(EndpointClassification)(classification).pipe(
    Effect.mapError((cause) => new InvalidInputError({
      field: "classification",
      detail: `Could not read the endpoint classification: ${String(cause)}`
    }))
  )
  const slug = IntegrationSlug.make(decoded.slug)
  const existing = yield* host.findIntegration(slug)
  if (Option.isSome(existing)) {
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

const named = (
  classification: EndpointClassification,
  options: DiscoverIntegrationsOptions
): EndpointClassification => ({
  ...classification,
  ...whenPresent("name", options.name),
  ...whenPresent("slug", options.slug)
})

const ensureConnection = Effect.fn("Integrations.ensureConnection")(function*(
  integration: Integration,
  connectionName: ConnectionName
): Effect.fn.Return<boolean, IntegrationFailure, Integrations> {
  const host = yield* Integrations
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
  IntegrationFailure | DetectionError,
  Integrations | ClassifyServices
> {
  const host = yield* Integrations
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
