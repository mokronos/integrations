import { Effect, Predicate } from "effect"
import { FetchHttpClient, HttpClientError } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { GatewayApi } from "@mokronos/gateway-api/definition"
import { NonNegativeInt, PositiveInt, whenPresent } from "@mokronos/contracts"
import {
  AccessProfileId,
  ApiKeyId,
  ApprovalDestinationId,
  ApprovalId,
  ApprovalPolicyId,
  ClientId
} from "@mokronos/gateway-core/domain"
import { Alias } from "@mokronos/contracts"
import type {
  ApprovalDelivery,
  ApprovalStatus,
  AccessProfileToolInput,
  ApprovalPolicyToolInput
} from "@/lib/schemas"

/**
 * What the dashboard shows when a call fails. The endpoints fail with the
 * error each route declares, which is what the code acts on; this is the
 * shape the alert renders.
 */
export class GatewayError extends Error {
  readonly status: number | undefined
  readonly method: string | undefined
  readonly path: string | undefined
  readonly requestId: string | undefined

  constructor(options: {
    readonly message: string
    readonly method?: string | undefined
    readonly path?: string | undefined
    readonly status?: number | undefined
    readonly requestId?: string | undefined
  }) {
    super(options.message)
    this.name = "GatewayError"
    this.status = options.status
    this.method = options.method
    this.path = options.path
    this.requestId = options.requestId
  }
}

/**
 * The errors the routes declare carry their human-readable text in `error`,
 * and leave `message` empty; everything else is an ordinary Error.
 */
const explains = (failure: Error): failure is Error & { readonly error: string } =>
  "error" in failure && Predicate.isString(failure.error) && failure.error.length > 0

const messageOf = (failure: Error): string =>
  explains(failure) ? failure.error : failure.message

const asGatewayError = (failure: Error): GatewayError => {
  if (HttpClientError.isHttpClientError(failure)) {
    const response = "response" in failure ? failure.response : undefined
    return new GatewayError({
      message: failure.message,
      method: failure.request.method,
      path: failure.request.url,
      ...whenPresent("status", response?.status),
      ...whenPresent("requestId", response?.headers["x-request-id"])
    })
  }
  return new GatewayError({ message: messageOf(failure) })
}

/**
 * The dashboard is served by the gateway it talks to, so calls go to the same
 * origin and carry the session cookie.
 */
const endpoints = Effect.runSync(
  HttpApiClient.make(GatewayApi, { baseUrl: window.location.origin }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { credentials: "same-origin" }),
    Effect.provide(FetchHttpClient.layer)
  )
)

const run = <A, E extends Error>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { credentials: "same-origin" }),
      Effect.mapError(asGatewayError)
    )
  )

export const listIntegrations = async () => {
  const response = await run(endpoints.provisioning.listIntegrations())
  return {
    integrations: response.integrations,
    oauthCallbackUrl: response.oauthCallbackUrl ?? undefined
  }
}

export const listIntegrationTools = async (slug: string) =>
  (await run(endpoints.provisioning.integrationTools({ params: { slug } }))).tools

export const describeTool = async (input: {
  readonly integration: string
  readonly tool: string
  readonly connection?: string
}) =>
  await run(endpoints.provisioning.describeTool({
    params: { slug: input.integration, tool: input.tool },
    query: { connection: input.connection }
  }))

export const searchRegistry = async (input: {
  readonly query: string
  readonly kind?: "mcp" | "openapi" | "graphql" | "cli"
  readonly limit?: number
}) =>
  await run(endpoints.provisioning.registrySearch({
    query: {
      q: input.query,
      ...whenPresent("kind", input.kind),
      limit: PositiveInt.make(input.limit ?? 5)
    }
  }))

export const discoverIntegration = async (input: {
  readonly url: string
  readonly connection?: string
  readonly slug?: string
  readonly name?: string
}) => await run(endpoints.provisioning.discover({ payload: input }))

export const renameIntegration = async (input: {
  readonly slug: string
  readonly name: string
}) =>
  await run(endpoints.provisioning.renameIntegration({
    params: { slug: input.slug },
    payload: { name: input.name }
  }))

export const listConnections = async () =>
  (await run(endpoints.provisioning.listConnections())).connections

export const createConnection = async (input: {
  readonly integration: string
  readonly connection?: string
  readonly template?: string
  readonly values?: Readonly<Record<string, string>>
}) => await run(endpoints.provisioning.connect({ payload: input }))

export const startOAuth = async (input: {
  readonly integration: string
  readonly connection?: string
  readonly template?: string
  readonly clientId?: string
  readonly clientSecret?: string
}) => await run(endpoints.provisioning.startOAuth({ payload: input }))

export const pollOAuth = async (id: string) =>
  await run(endpoints.provisioning.oauthSession({ params: { id } }))

export const removeIntegration = async (slug: string) =>
  await run(endpoints.provisioning.removeIntegration({ params: { slug } }))

export const removeConnection = async (input: {
  readonly integration: string
  readonly name: string
}) =>
  await run(endpoints.provisioning.removeConnection({
    params: { integration: input.integration, name: input.name }
  }))

export const listClients = async () => {
  const response = await run(endpoints.administrative.listClients())
  return { clients: response.clients, mcpUrl: response.mcpUrl ?? undefined }
}

export const fetchOverview = async () => await run(endpoints.administrative.overview())

export const createConfiguredClient = async (
  input: import("@mokronos/gateway-core/domain").ConfigureClient
) => await run(endpoints.administrative.createConfiguredClient({ payload: input }))

export const createClient = async (input: {
  readonly name: string
  readonly accessProfileId?: string
  readonly approvalPolicyId?: string
  readonly capabilities: ReadonlyArray<"provision_connections" | "administer_gateway">
  readonly approvalDelivery: ApprovalDelivery
}) =>
  await run(endpoints.administrative.createClient({
    payload: {
      name: input.name,
      capabilities: input.capabilities,
      approvalDelivery: input.approvalDelivery,
      ...whenPresent(
        "accessProfileId",
        input.accessProfileId === undefined ? undefined : AccessProfileId.make(input.accessProfileId)
      ),
      ...whenPresent(
        "approvalPolicyId",
        input.approvalPolicyId === undefined ? undefined : ApprovalPolicyId.make(input.approvalPolicyId)
      )
    }
  }))

export const updateClientSettings = async (input: {
  readonly clientId: string
  readonly capabilities: ReadonlyArray<"provision_connections" | "administer_gateway">
  readonly approvalDelivery: ApprovalDelivery
}) =>
  await run(endpoints.administrative.updateClientSettings({
    params: { id: ClientId.make(input.clientId) },
    payload: { capabilities: input.capabilities, approvalDelivery: input.approvalDelivery }
  }))

export const listApprovalDestinations = async () =>
  (await run(endpoints.administrative.listApprovalDestinations())).destinations

export const createApprovalDestination = async (
  input: { readonly name: string; readonly url: string }
) => await run(endpoints.administrative.createApprovalDestination({ payload: input }))

export const deleteApprovalDestination = async (id: string) =>
  await run(endpoints.administrative.deleteApprovalDestination({ params: { id: ApprovalDestinationId.make(id) } }))

export const getClientApprovalDestinations = async (clientId: string) =>
  (await run(endpoints.administrative.getClientApprovalDestinations({
    params: { id: ClientId.make(clientId) }
  }))).destinationIds

export const replaceClientApprovalDestinations = async (
  clientId: string,
  destinationIds: ReadonlyArray<string>
) =>
  (await run(endpoints.administrative.replaceClientApprovalDestinations({
    params: { id: ClientId.make(clientId) },
    payload: { destinationIds: destinationIds.map((id) => ApprovalDestinationId.make(id)) }
  }))).destinationIds

export const issueKey = async (clientId: string) =>
  await run(endpoints.administrative.issueKey({ params: { id: ClientId.make(clientId) } }))

export const listKeys = async (clientId: string) =>
  (await run(endpoints.administrative.listKeys({ params: { id: ClientId.make(clientId) } }))).keys

export const revokeKey = async (keyId: string) =>
  await run(endpoints.administrative.revokeKey({ params: { id: ApiKeyId.make(keyId) } }))

export const listClientTools = async (clientId: string, schemas = false) =>
  (await run(endpoints.administrative.clientTools({
    params: { id: ClientId.make(clientId) },
    query: { schemas }
  }))).tools

export const revokeClient = async (clientId: string) =>
  await run(endpoints.administrative.revokeClient({ params: { id: ClientId.make(clientId) } }))

export const listAccessProfiles = async () =>
  (await run(endpoints.administrative.listAccessProfiles())).accessProfiles

export const getAccessProfile = async (id: string) =>
  await run(endpoints.administrative.getAccessProfile({ params: { id: AccessProfileId.make(id) } }))

export const createAccessProfile = async (name: string) =>
  await run(endpoints.administrative.createAccessProfile({ payload: { name } }))

export const cloneAccessProfile = async (id: string, name: string) =>
  await run(endpoints.administrative.cloneAccessProfile({
    params: { id: AccessProfileId.make(id) },
    payload: { name }
  }))

export const replaceAccessProfileTools = async (
  id: string,
  tools: ReadonlyArray<AccessProfileToolInput>
) =>
  await run(endpoints.administrative.replaceAccessProfileTools({
    params: { id: AccessProfileId.make(id) },
    payload: { tools }
  }))

export const assignAccessProfile = async (clientId: string, accessProfileId: string) =>
  await run(endpoints.administrative.assignAccessProfile({
    params: { id: ClientId.make(clientId) },
    payload: { accessProfileId: AccessProfileId.make(accessProfileId) }
  }))

export const listApprovalPolicies = async () =>
  (await run(endpoints.administrative.listApprovalPolicies())).approvalPolicies

export const getApprovalPolicy = async (id: string) =>
  await run(endpoints.administrative.getApprovalPolicy({ params: { id: ApprovalPolicyId.make(id) } }))

export const createApprovalPolicy = async (name: string) =>
  await run(endpoints.administrative.createApprovalPolicy({ payload: { name } }))

export const cloneApprovalPolicy = async (id: string, name: string) =>
  await run(endpoints.administrative.cloneApprovalPolicy({
    params: { id: ApprovalPolicyId.make(id) },
    payload: { name }
  }))

export const replaceApprovalPolicyTools = async (
  id: string,
  tools: ReadonlyArray<ApprovalPolicyToolInput>
) =>
  await run(endpoints.administrative.replaceApprovalPolicyTools({
    params: { id: ApprovalPolicyId.make(id) },
    payload: { tools }
  }))

export const assignApprovalPolicy = async (clientId: string, approvalPolicyId: string) =>
  await run(endpoints.administrative.assignApprovalPolicy({
    params: { id: ClientId.make(clientId) },
    payload: { approvalPolicyId: ApprovalPolicyId.make(approvalPolicyId) }
  }))

export const listApprovals = async (status?: ApprovalStatus) =>
  (await run(endpoints.administrative.listApprovals({
    query: { ...whenPresent("status", status) }
  }))).approvals

export const listApprovalDeliveries = async (approvalId: string) =>
  (await run(endpoints.administrative.listApprovalDeliveries({
    params: { id: ApprovalId.make(approvalId) }
  }))).deliveries

export const approveApproval = async (input: { readonly id: string }) =>
  await run(endpoints.administrative.approve({ params: { id: ApprovalId.make(input.id) } }))

export const denyApproval = async (input: { readonly id: string }) =>
  await run(endpoints.administrative.deny({ params: { id: ApprovalId.make(input.id) } }))

export type AuditQuery = {
  readonly limit: number
  readonly offset: number
  readonly clientId?: string
  readonly alias?: string
  readonly tool?: string
  readonly outcome?: "succeeded" | "failed" | "denied" | "pending"
  readonly since?: string
}

export const listAudit = async (input: AuditQuery) => {
  const response = await run(endpoints.administrative.audit({
    query: {
      limit: PositiveInt.make(input.limit),
      offset: NonNegativeInt.make(input.offset),
      ...whenPresent("clientId", input.clientId === undefined ? undefined : ClientId.make(input.clientId)),
      ...whenPresent("alias", input.alias === undefined ? undefined : Alias.make(input.alias)),
      ...whenPresent("tool", input.tool),
      ...whenPresent("outcome", input.outcome),
      ...whenPresent("since", input.since === undefined ? undefined : new Date(input.since))
    }
  }))
  return {
    records: response.records,
    total: response.total,
    limit: response.limit,
    offset: response.offset
  }
}

export const refreshDrift = async (integration?: string) =>
  (await run(endpoints.administrative.refreshDrift({
    query: { ...whenPresent("integration", integration) }
  }))).reports

export type Me = Awaited<ReturnType<typeof fetchMe>>

export const fetchMe = async () => await run(endpoints.auth.whoami())

export const fetchAuthProviders = async () => await run(endpoints.auth.providers())

export const signUp = async (input: {
  readonly email: string
  readonly password: string
  readonly tenantName?: string | undefined
}): Promise<void> => {
  await run(endpoints.auth.signup({
    payload: {
      email: input.email,
      password: input.password,
      ...whenPresent("tenantName", input.tenantName)
    }
  }))
}

export const logIn = async (
  input: { readonly email: string; readonly password: string }
): Promise<void> => {
  await run(endpoints.auth.login({ payload: input }))
}

export const logOut = async (): Promise<void> => {
  await run(endpoints.auth.logout())
}

export const changeEmail = async (input: {
  readonly email: string
  readonly password: string
}): Promise<string> =>
  (await run(endpoints.auth.changeEmail({ payload: input }))).email

export const changePassword = async (input: {
  readonly currentPassword?: string
  readonly newPassword: string
}): Promise<number> =>
  (await run(endpoints.auth.changePassword({ payload: input }))).revokedSessions

export const deleteAccount = async (input: {
  readonly password?: string
}): Promise<void> => {
  await run(endpoints.auth.deleteAccount({ payload: input }))
}
