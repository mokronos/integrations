import { Duration, Effect, Fiber, Predicate, Schedule, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClientError } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { GatewayApi, GatewayFailure } from "@integragents/gateway-api/definition"
import {
  Alias,
  ClientId,
  NonNegativeInt,
  PositiveInt,
  whenPresent,
  type AccessProfileId,
  type ApiKeyId,
  type ApprovalMethod,
  type GatewayEvent,
  type ApprovalDestinationId,
  type ApprovalId,
  type ApprovalPolicyId,
  type ApprovalStatus,
  type AuditOutcome,
  type ClientCapability,
  type ConfigureClient,
  type ConnectionRef,
  type IntegrationSearchKind,
  type McpSurface,
  type OAuthConsentDecision,
  type OAuthGrantId,
  type PolicyDecision
} from "@integragents/contracts"

export class GatewayError extends Error {
  readonly status: number | undefined
  readonly method: string | undefined
  readonly path: string | undefined
  readonly traceId: string | undefined
  readonly code: string | undefined

  constructor(options: {
    readonly message: string
    readonly code?: string | undefined
    readonly method?: string | undefined
    readonly path?: string | undefined
    readonly status?: number | undefined
    readonly traceId?: string | undefined
  }) {
    super(options.message)
    this.name = "GatewayError"
    this.status = options.status
    this.method = options.method
    this.path = options.path
    this.traceId = options.traceId
    this.code = options.code
  }
}

const messageOf = (failure: Error): string =>
  Predicate.hasProperty(failure, "error") && Predicate.isString(failure.error) && failure.error.length > 0
    ? failure.error
    : failure.message

const asGatewayError = (failure: Error): GatewayError => {
  if (failure instanceof GatewayFailure) {
    return new GatewayError({
      message: `${failure.message} (trace ${failure.traceId})`,
      status: 500,
      traceId: failure.traceId
    })
  }
  if (HttpClientError.isHttpClientError(failure)) {
    const response = "response" in failure ? failure.response : undefined
    return new GatewayError({
      message: failure.message,
      method: failure.request.method,
      path: failure.request.url,
      ...whenPresent("status", response?.status)
    })
  }
  return new GatewayError({
    message: messageOf(failure),
    ...whenPresent("code", Predicate.hasProperty(failure, "code") && Predicate.isString(failure.code) ? failure.code : undefined)
  })
}

const endpoints = Effect.runSync(
  HttpApiClient.make(GatewayApi, { baseUrl: window.location.origin }).pipe(
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

class EventStreamStalled extends Schema.TaggedError<EventStreamStalled>()("EventStreamStalled", {}) {}

/** The gateway sends a heartbeat every five seconds; three missed ones mean the stream is gone. */
const eventStreamStallAfter = Duration.seconds(15)

/** Follows `/v1/events` until the returned function is called, reconnecting whenever the stream drops. */
export const followEvents = (onEvent: (event: GatewayEvent) => void): (() => void) => {
  const fiber = Effect.runFork(
    endpoints.administrative.events().pipe(
      Effect.flatMap((events) =>
        Stream.runForEach(Stream.timeout(events, eventStreamStallAfter), (event) => Effect.sync(() => onEvent(event)))),
      Effect.andThen(Effect.fail(new EventStreamStalled())),
      Effect.provideService(FetchHttpClient.RequestInit, { credentials: "same-origin" }),
      Effect.retry(Schedule.spaced(Duration.seconds(3)))
    )
  )
  return () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
}

export const listIntegrations = async () => {
  const response = await run(endpoints.provisioning.listIntegrations())
  return {
    integrations: response.integrations,
    oauthCallbackUrl: response.oauthCallbackUrl ?? undefined
  }
}

export const searchRegistry = async (input: {
  readonly query: string
  readonly kind?: IntegrationSearchKind
  readonly limit: number
}) =>
  await run(endpoints.provisioning.registrySearch({
    query: { q: input.query, ...whenPresent("kind", input.kind), limit: PositiveInt.make(input.limit) }
  }))

export const discoverIntegration = async (input: {
  readonly url: string
  readonly connection?: string
  readonly slug?: string
  readonly name?: string
}) => await run(endpoints.provisioning.discover({ payload: input }))

export const renameIntegration = async (input: { readonly slug: string; readonly name: string }) =>
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

export const getOAuthSession = async (id: string) =>
  await run(endpoints.provisioning.oauthSession({ params: { id } }))

export const provideOAuthClient = async (
  id: string,
  payload: { readonly clientId: string; readonly clientSecret?: string }
) => await run(endpoints.provisioning.provideOAuthClient({ params: { id }, payload }))

export const removeIntegration = async (slug: string) =>
  await run(endpoints.provisioning.removeIntegration({ params: { slug } }))

export const removeConnection = async (input: { readonly integration: string; readonly name: string }) =>
  await run(endpoints.provisioning.removeConnection({ params: input }))

export const listClients = async () => {
  const response = await run(endpoints.administrative.listClients())
  return { clients: response.clients, gatewayUrl: response.gatewayUrl ?? undefined, mcpUrl: response.mcpUrl ?? undefined }
}

export const fetchOverview = async () => await run(endpoints.administrative.overview())

export const createConfiguredClient = async (input: ConfigureClient) =>
  await run(endpoints.administrative.createConfiguredClient({ payload: input }))

export const createClient = async (input: {
  readonly name: string
  readonly accessProfileId?: AccessProfileId
  readonly approvalPolicyId?: ApprovalPolicyId
  readonly capabilities: ReadonlyArray<ClientCapability>
}) => await run(endpoints.administrative.createClient({ payload: input }))

export const renameClient = async (id: ClientId, name: string) =>
  await run(endpoints.administrative.renameClient({ params: { id }, payload: { name } }))

export const updateClientSettings = async (id: ClientId, settings: {
  readonly capabilities: ReadonlyArray<ClientCapability>
  readonly approvalMethod: ApprovalMethod
  readonly mcpSurface: McpSurface
}) => await run(endpoints.administrative.updateClientSettings({ params: { id }, payload: settings }))

export const listApprovalDestinations = async () =>
  (await run(endpoints.administrative.listApprovalDestinations())).destinations

export const createApprovalDestination = async (input: { readonly name: string; readonly url: string }) =>
  await run(endpoints.administrative.createApprovalDestination({ payload: input }))

export const deleteApprovalDestination = async (id: ApprovalDestinationId) =>
  await run(endpoints.administrative.deleteApprovalDestination({ params: { id } }))

export const getClientApprovalDestinations = async (id: ClientId) =>
  (await run(endpoints.administrative.getClientApprovalDestinations({ params: { id } }))).destinationIds

export const replaceClientApprovalDestinations = async (
  id: ClientId,
  destinationIds: ReadonlyArray<ApprovalDestinationId>
) =>
  (await run(endpoints.administrative.replaceClientApprovalDestinations({
    params: { id },
    payload: { destinationIds }
  }))).destinationIds

export const issueKey = async (id: ClientId) =>
  await run(endpoints.administrative.issueKey({ params: { id } }))

export const listKeys = async (id: ClientId) =>
  (await run(endpoints.administrative.listKeys({ params: { id } }))).keys

export const revokeKey = async (id: ApiKeyId) =>
  await run(endpoints.administrative.revokeKey({ params: { id } }))

export const listClientTools = async (id: ClientId) =>
  (await run(endpoints.administrative.clientTools({ params: { id }, query: { schemas: false } }))).tools

export const revokeClient = async (id: ClientId) =>
  await run(endpoints.administrative.revokeClient({ params: { id } }))

export const listAccessProfiles = async () =>
  (await run(endpoints.administrative.listAccessProfiles())).accessProfiles

export const getAccessProfile = async (id: AccessProfileId) =>
  await run(endpoints.administrative.getAccessProfile({ params: { id } }))

export const createAccessProfile = async (name: string) =>
  await run(endpoints.administrative.createAccessProfile({ payload: { name } }))

export const renameAccessProfile = async (id: AccessProfileId, name: string) =>
  await run(endpoints.administrative.updateAccessProfile({ params: { id }, payload: { name } }))

export const deleteAccessProfile = async (id: AccessProfileId) =>
  await run(endpoints.administrative.deleteAccessProfile({ params: { id } }))

export const cloneAccessProfile = async (id: AccessProfileId, name: string) =>
  await run(endpoints.administrative.cloneAccessProfile({ params: { id }, payload: { name } }))

export const replaceAccessProfileTools = async (
  id: AccessProfileId,
  tools: ReadonlyArray<{ readonly connection: ConnectionRef; readonly tool: string }>
) => await run(endpoints.administrative.replaceAccessProfileTools({ params: { id }, payload: { tools } }))

export const assignAccessProfile = async (id: ClientId, accessProfileId: AccessProfileId) =>
  await run(endpoints.administrative.assignAccessProfile({ params: { id }, payload: { accessProfileId } }))

export const listApprovalPolicies = async () =>
  (await run(endpoints.administrative.listApprovalPolicies())).approvalPolicies

export const getApprovalPolicy = async (id: ApprovalPolicyId) =>
  await run(endpoints.administrative.getApprovalPolicy({ params: { id } }))

export const createApprovalPolicy = async (name: string) =>
  await run(endpoints.administrative.createApprovalPolicy({ payload: { name } }))

export const renameApprovalPolicy = async (id: ApprovalPolicyId, name: string) =>
  await run(endpoints.administrative.updateApprovalPolicy({ params: { id }, payload: { name } }))

export const deleteApprovalPolicy = async (id: ApprovalPolicyId) =>
  await run(endpoints.administrative.deleteApprovalPolicy({ params: { id } }))

export const cloneApprovalPolicy = async (id: ApprovalPolicyId, name: string) =>
  await run(endpoints.administrative.cloneApprovalPolicy({ params: { id }, payload: { name } }))

export const replaceApprovalPolicyTools = async (
  id: ApprovalPolicyId,
  tools: ReadonlyArray<{ readonly connection: ConnectionRef; readonly tool: string; readonly decision: PolicyDecision }>
) => await run(endpoints.administrative.replaceApprovalPolicyTools({ params: { id }, payload: { tools } }))

export const assignApprovalPolicy = async (id: ClientId, approvalPolicyId: ApprovalPolicyId) =>
  await run(endpoints.administrative.assignApprovalPolicy({ params: { id }, payload: { approvalPolicyId } }))

export const listApprovals = async (status?: ApprovalStatus) =>
  (await run(endpoints.administrative.listApprovals({ query: whenPresent("status", status) }))).approvals


export const approveApproval = async (id: ApprovalId) =>
  await run(endpoints.administrative.approve({ params: { id } }))

export const denyApproval = async (id: ApprovalId) =>
  await run(endpoints.administrative.deny({ params: { id } }))

export type AuditQuery = {
  readonly limit: number
  readonly offset: number
  readonly clientId?: string
  readonly alias?: string
  readonly tool?: string
  readonly outcome?: AuditOutcome
  readonly since?: string
}

export const listAudit = async (input: AuditQuery) =>
  await run(endpoints.administrative.audit({
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

export const refreshDrift = async (integration?: string) =>
  (await run(endpoints.administrative.refreshDrift({ query: whenPresent("integration", integration) }))).reports

export type Me = Awaited<ReturnType<typeof fetchMe>>

export const fetchMe = async () => await run(endpoints.auth.whoami())

export type AuthProviders = Awaited<ReturnType<typeof fetchAuthProviders>>

export const fetchAuthProviders = async () => await run(endpoints.auth.providers())

export const signUp = async (input: {
  readonly email: string
  readonly password: string
  readonly tenantName?: string
}) => await run(endpoints.auth.signup({ payload: input }))

export const logIn = async (input: { readonly email: string; readonly password: string }) =>
  await run(endpoints.auth.login({ payload: input }))

export const logOut = async () => await run(endpoints.auth.logout())

export const changeEmail = async (input: { readonly email: string; readonly password: string }) =>
  (await run(endpoints.auth.changeEmail({ payload: input }))).email

export const changePassword = async (input: {
  readonly currentPassword?: string
  readonly newPassword: string
}) => (await run(endpoints.auth.changePassword({ payload: input }))).revokedSessions

export const deleteAccount = async (input: { readonly password?: string }) =>
  await run(endpoints.auth.deleteAccount({ payload: input }))

export type OAuthConsent = Awaited<ReturnType<typeof getOAuthConsent>>

export const getOAuthConsent = async (id: string) =>
  await run(endpoints.oauth.consent({ query: { id } }))

export const decideOAuthConsent = async (id: string, decision: OAuthConsentDecision) =>
  (await run(decision.decision === "deny"
    ? endpoints.oauth.decideConsent({ query: { id }, payload: decision })
    : endpoints.oauth.decideConsent({ query: { id }, payload: decision }))).redirect

export const listOAuthGrants = async () =>
  (await run(endpoints.oauth.listGrants())).grants

export const revokeOAuthGrant = async (id: OAuthGrantId) =>
  await run(endpoints.oauth.revokeGrant({ params: { id } }))
