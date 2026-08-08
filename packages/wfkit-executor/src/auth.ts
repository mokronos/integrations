import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState
} from "@executor-js/sdk/core"
import { runExecutor } from "./host.ts"
import type { ExecutorRunner } from "./host.ts"
import type { ExecutorConnection } from "./schemas.ts"

const defaultExecutorRunner: ExecutorRunner = { run: runExecutor }

/** Reads OAuth server metadata without changing catalog or connection state. */
export const probeExecutorOAuth = async (
  url: string,
  runner: ExecutorRunner = defaultExecutorRunner
) => await runner.run((executor) => executor.oauth.probe({ url }))

export const registerExecutorOAuthClient = async (options: {
  readonly slug: string
  readonly integration: string
  readonly redirectUri: string
  readonly issuer?: string | null
  readonly registrationEndpoint: string
  readonly authorizationUrl: string
  readonly tokenUrl: string
  readonly resource?: string | null
  readonly scopes: ReadonlyArray<string>
  readonly tokenEndpointAuthMethodsSupported?: ReadonlyArray<string>
}, runner: ExecutorRunner = defaultExecutorRunner): Promise<string> =>
  await runner.run((executor) => executor.oauth.registerDynamicClient({
    owner: "org",
    slug: OAuthClientSlug.make(options.slug),
    originIntegration: IntegrationSlug.make(options.integration),
    redirectUri: options.redirectUri,
    registrationEndpoint: options.registrationEndpoint,
    authorizationUrl: options.authorizationUrl,
    tokenUrl: options.tokenUrl,
    scopes: options.scopes,
    ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
    ...(options.resource === undefined ? {} : { resource: options.resource }),
    ...(options.tokenEndpointAuthMethodsSupported === undefined
      ? {}
      : { tokenEndpointAuthMethodsSupported: options.tokenEndpointAuthMethodsSupported })
  })).then(String)

export const createExecutorOAuthClient = async (options: {
  readonly slug: string
  readonly integration: string
  readonly authorizationUrl: string
  readonly tokenUrl: string
  readonly clientId: string
  readonly clientSecret?: string
  readonly resource?: string | null
}, runner: ExecutorRunner = defaultExecutorRunner): Promise<string> =>
  await runner.run((executor) => executor.oauth.createClient({
    owner: "org",
    slug: OAuthClientSlug.make(options.slug),
    origin: {
      kind: "manual",
      integration: IntegrationSlug.make(options.integration)
    },
    grant: "authorization_code",
    authorizationUrl: options.authorizationUrl,
    tokenUrl: options.tokenUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret ?? "",
    ...(options.resource === undefined ? {} : { resource: options.resource })
  })).then(String)

export const startExecutorOAuth = async (options: {
  readonly client: string
  readonly integration: string
  readonly connection: string
  readonly template: string
  readonly redirectUri: string
}, runner: ExecutorRunner = defaultExecutorRunner) =>
  await runner.run((executor) => executor.oauth.start({
    owner: "org",
    clientOwner: "org",
    client: OAuthClientSlug.make(options.client),
    integration: IntegrationSlug.make(options.integration),
    name: ConnectionName.make(options.connection),
    template: AuthTemplateSlug.make(options.template),
    redirectUri: options.redirectUri
  }))

export const completeExecutorOAuth = async (options: {
  readonly state: string
  readonly code: string
  readonly callbackDomain?: string | null
}, runner: ExecutorRunner = defaultExecutorRunner): Promise<ExecutorConnection> =>
  await runner.run((executor) => executor.oauth.complete({
    state: OAuthState.make(options.state),
    code: options.code,
    ...(options.callbackDomain === undefined ? {} : { callbackDomain: options.callbackDomain })
  })).then((connection) => ({
    owner: connection.owner,
    name: String(connection.name),
    integration: String(connection.integration),
    template: String(connection.template),
    address: String(connection.address),
    ...(connection.identityLabel === undefined ? {} : { identityLabel: connection.identityLabel }),
    ...(connection.expiresAt === undefined ? {} : { expiresAt: connection.expiresAt })
  }))

/** OAuth operations bound to an explicit host/runner. */
export const createExecutorAuth = (runner: ExecutorRunner) => ({
  probe: (url: string) => probeExecutorOAuth(url, runner),
  registerClient: (options: Parameters<typeof registerExecutorOAuthClient>[0]) =>
    registerExecutorOAuthClient(options, runner),
  createClient: (options: Parameters<typeof createExecutorOAuthClient>[0]) =>
    createExecutorOAuthClient(options, runner),
  start: (options: Parameters<typeof startExecutorOAuth>[0]) =>
    startExecutorOAuth(options, runner),
  complete: (options: Parameters<typeof completeExecutorOAuth>[0]) =>
    completeExecutorOAuth(options, runner)
})

export type ExecutorAuth = ReturnType<typeof createExecutorAuth>
