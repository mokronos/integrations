import { IntegrationSlug } from "@executor-js/sdk/core"
import { Option } from "effect"
import { runExecutor } from "./host.ts"
import type {
  ExecutorDetection,
  ExecutorIntegration,
  ExecutorMcpProbe,
  ExecutorOpenApiPreview
} from "./schemas.ts"

/** Read-only endpoint detection. It neither installs the integration nor creates
 * a connection. */
export const detectExecutorIntegration = async (
  url: string
): Promise<ReadonlyArray<ExecutorDetection>> =>
  await runExecutor((executor) => executor.integrations.detect(url))

/** Read-only MCP endpoint inspection. */
export const probeExecutorMcp = async (url: string): Promise<ExecutorMcpProbe> =>
  await runExecutor((executor) => executor.mcp.probeEndpoint(url))

/** Read-only OpenAPI document inspection. */
export const previewExecutorOpenApi = async (spec: string): Promise<ExecutorOpenApiPreview> => {
  const preview = await runExecutor((executor) => executor.openapi.previewSpec(spec))
  return {
    title: Option.getOrNull(preview.title),
    version: Option.getOrNull(preview.version),
    operationCount: preview.operationCount,
    servers: preview.servers.map((server) => ({ url: server.url })),
    securitySchemes: preview.securitySchemes.map((scheme) => ({
      name: scheme.name,
      type: scheme.type,
      scheme: Option.getOrNull(scheme.scheme),
      headerName: Option.getOrNull(scheme.headerName)
    }))
  }
}

/** Installs an MCP endpoint in the persisted integration catalog. */
export const addExecutorMcp = async (options: {
  readonly endpoint: string
  readonly name: string
  readonly slug: string
  readonly auth: "none" | "oauth2" | "bearer"
}): Promise<string> =>
  await runExecutor((executor) => executor.mcp.addServer({
    transport: "remote",
    endpoint: options.endpoint,
    name: options.name,
    slug: options.slug,
    auth: options.auth === "bearer"
      ? { kind: "header", headerName: "Authorization", prefix: "Bearer " }
      : { kind: options.auth }
  })).then((result) => result.slug)

/** Installs an OpenAPI document in the persisted integration catalog. */
export const addExecutorOpenApi = async (options: {
  readonly spec: string
  readonly slug: string
  readonly name?: string
  readonly baseUrl?: string
}): Promise<string> =>
  await runExecutor((executor) => executor.openapi.addSpec({
    spec: { kind: "url", url: options.spec },
    slug: options.slug,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl })
  })).then((result) => String(result.slug))

/** Lists integrations already installed in the persisted catalog. */
export const listExecutorIntegrations = async (): Promise<ReadonlyArray<ExecutorIntegration>> =>
  await runExecutor((executor) => executor.integrations.list()).then((integrations) =>
    integrations.filter((integration) => integration.kind !== "built-in").map((integration) => ({
      slug: String(integration.slug),
      name: integration.name,
      description: integration.description,
      kind: integration.kind,
      authMethods: integration.authMethods.map((method) => ({
        id: method.id,
        label: method.label,
        kind: method.kind,
        template: method.template,
        ...(method.oauth === undefined ? {} : {
          oauth: {
            ...(method.oauth.discoveryUrl === undefined ? {} : { discoveryUrl: method.oauth.discoveryUrl }),
            ...(method.oauth.authorizationUrl === undefined ? {} : { authorizationUrl: method.oauth.authorizationUrl }),
            ...(method.oauth.tokenUrl === undefined ? {} : { tokenUrl: method.oauth.tokenUrl }),
            ...(method.oauth.resource === undefined ? {} : { resource: method.oauth.resource }),
            ...(method.oauth.scopes === undefined ? {} : { scopes: method.oauth.scopes }),
            ...(method.oauth.registrationEndpoint === undefined ? {} : { registrationEndpoint: method.oauth.registrationEndpoint }),
            ...(method.oauth.supportsDynamicRegistration === undefined
              ? {}
              : { supportsDynamicRegistration: method.oauth.supportsDynamicRegistration })
          }
        })
      })),
      ...(integration.displayUrl === undefined ? {} : { displayUrl: integration.displayUrl })
    }))
  )

/** Resolves one installed integration without coupling callers to list/filter
 * details. */
export const findExecutorIntegration = async (
  slug: string
): Promise<ExecutorIntegration | undefined> =>
  (await listExecutorIntegrations()).find((integration) =>
    IntegrationSlug.make(integration.slug) === IntegrationSlug.make(slug)
  )
