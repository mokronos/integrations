import { IntegrationSlug } from "@executor-js/sdk/core"
import { Option, Schema } from "effect"
import { runExecutor } from "./default-host.ts"
import type { ExecutorRunner } from "./host.ts"
import {
  ExecutorDetection,
  ExecutorIntegration,
  ExecutorMcpProbe,
  ExecutorOpenApiPreview
} from "./schemas.ts"

export interface ExecutorCatalog {
  readonly detectIntegration: (url: string) => Promise<ReadonlyArray<ExecutorDetection>>
  readonly probeMcp: (url: string) => Promise<ExecutorMcpProbe>
  readonly previewOpenApi: (spec: string) => Promise<ExecutorOpenApiPreview>
  readonly addMcp: (options: {
    readonly endpoint: string
    readonly name: string
    readonly slug: string
    readonly auth: "none" | "oauth2" | "bearer"
  }) => Promise<string>
  readonly addOpenApi: (options: {
    readonly spec: string
    readonly slug: string
    readonly name?: string
    readonly baseUrl?: string
  }) => Promise<string>
  readonly list: () => Promise<ReadonlyArray<ExecutorIntegration>>
  readonly find: (slug: string) => Promise<ExecutorIntegration | undefined>
}

/** Catalog operations bound to an explicit host/runner. */
export const createExecutorCatalog = (runner: ExecutorRunner): ExecutorCatalog => {
  const list = async (): Promise<ReadonlyArray<ExecutorIntegration>> =>
    await runner.run((executor) => executor.integrations.list()).then((integrations) =>
      Schema.decodeUnknownSync(Schema.Array(ExecutorIntegration))(
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
    )

  const catalog: ExecutorCatalog = {
    detectIntegration: async (url) => Schema.decodeUnknownSync(Schema.Array(ExecutorDetection))(
      await runner.run((executor) => executor.integrations.detect(url))
    ),
    probeMcp: async (url) => Schema.decodeUnknownSync(ExecutorMcpProbe)(
      await runner.run((executor) => executor.mcp.probeEndpoint(url))
    ),
    previewOpenApi: async (spec) => {
      const preview = await runner.run((executor) => executor.openapi.previewSpec(spec))
      return Schema.decodeUnknownSync(ExecutorOpenApiPreview)({
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
      })
    },
    addMcp: async (options) =>
      await runner.run((executor) => executor.mcp.addServer({
        transport: "remote",
        endpoint: options.endpoint,
        name: options.name,
        slug: options.slug,
        auth: options.auth === "bearer"
          ? { kind: "header", headerName: "Authorization", prefix: "Bearer " }
          : { kind: options.auth }
      })).then((result) => result.slug),
    addOpenApi: async (options) =>
      await runner.run((executor) => executor.openapi.addSpec({
        spec: { kind: "url", url: options.spec },
        slug: options.slug,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl })
      })).then((result) => String(result.slug)),
    list,
    find: async (slug) =>
      (await list()).find((integration) =>
        IntegrationSlug.make(integration.slug) === IntegrationSlug.make(slug)
      )
  }
  return catalog
}

const defaultCatalog = createExecutorCatalog({ run: runExecutor })

/** Read-only endpoint detection. It neither installs the integration nor creates
 * a connection. */
export const detectExecutorIntegration = defaultCatalog.detectIntegration

/** Read-only MCP endpoint inspection. */
export const probeExecutorMcp = defaultCatalog.probeMcp

/** Read-only OpenAPI document inspection. */
export const previewExecutorOpenApi = defaultCatalog.previewOpenApi

/** Installs an MCP endpoint in the persisted integration catalog. */
export const addExecutorMcp = defaultCatalog.addMcp

/** Installs an OpenAPI document in the persisted integration catalog. */
export const addExecutorOpenApi = defaultCatalog.addOpenApi

/** Lists integrations already installed in the persisted catalog. */
export const listExecutorIntegrations = defaultCatalog.list

/** Resolves one installed integration without coupling callers to list/filter
 * details. */
export const findExecutorIntegration = defaultCatalog.find
