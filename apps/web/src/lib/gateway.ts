import { Schema } from "effect"
import { type JsonEncodable, whenPresent, whenPresentFields } from "@mokronos/contracts"
import { Predicate } from "effect"
import {
  decodeApprovalDecided,
  decodeAuthProviders,
  decodeApprovals,
  decodeAudit,
  decodeGrantCreated,
  decodeGrants,
  decodeClient,
  decodeClients,
  decodeConnectionCreated,
  decodeConnections,
  decodeDiscovery,
  decodeDrift,
  decodeEffectiveTools,
  decodeIntegrations,
  decodeIssuedKey,
  decodeEmailChanged,
  decodeMe,
  decodePasswordChanged,
  decodeKeys,
  decodeOAuthSession,
  decodeOverview,
  decodePolicies,
  decodePolicy,
  decodePolicyCreated,
  decodePolicyToolsReplaced,
  decodeRemoved,
  decodeRegistrySearch,
  decodeRevoked,
  decodeTool,
  decodeTools
} from "@/lib/schemas"
import type {
  ApprovalDelivery,
  ApprovalStatus,
  PolicyToolInput
} from "@/lib/schemas"

/** The gateway's API, as the control plane uses it.
 *
 * There is no API key here and no place to put one: the page is served by the
 * gateway, so the browser's own same-origin request is what authenticates it.
 * See `packages/core/api/src/http/loopback.ts` for why that is safe and
 * where it stops being safe.
 */

export class GatewayError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "GatewayError"
    this.status = status
  }
}

const messageFrom = (payload: Schema.Json, fallback: string): string => {
  if (Predicate.isObject(payload) && "error" in payload) {
    const error = payload["error"]
    if (Predicate.isString(error) && error.length > 0) return error
  }
  return fallback
}

/** The response body is unparsed text off the wire, so it is decoded rather
 *  than trusted before any caller sees it. */
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

const request = async (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: JsonEncodable
): Promise<Schema.Json> => {
  const response = await fetch(path, {
    method,
    // Same-origin only. Anything else would not be authenticated anyway.
    credentials: "same-origin",
    ...whenPresentFields(body, (present) => ({
      headers: { "content-type": "application/json" },
      body: JSON.stringify(present)
    }))
  })
  const text = await response.text()
  const payload = text.trim().length === 0 ? {} : decodeJsonText(text)
  if (!response.ok) {
    throw new GatewayError(
      response.status,
      messageFrom(payload, `${method} ${path} failed with ${response.status}`)
    )
  }
  return payload
}

const query = (parameters: Readonly<Record<string, string | number | undefined>>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const rendered = search.toString()
  return rendered.length === 0 ? "" : `?${rendered}`
}

const segment = (value: string): string => encodeURIComponent(value)

// --- catalog and connections ------------------------------------------------

export const listIntegrations = async () => {
  const response = decodeIntegrations(await request("GET", "/v1/integrations"))
  return {
    integrations: response.integrations,
    oauthCallbackUrl: response.oauthCallbackUrl ?? undefined
  }
}

export const listIntegrationTools = async (slug: string) =>
  decodeTools(await request("GET", `/v1/integrations/${segment(slug)}/tools`)).tools

export const describeTool = async (input: {
  readonly integration: string
  readonly tool: string
  readonly connection?: string
}) =>
  decodeTool(await request(
    "GET",
    `/v1/integrations/${segment(input.integration)}/tools/${segment(input.tool)}${
      query({ connection: input.connection })
    }`
  ))

export const searchRegistry = async (input: {
  readonly query: string
  readonly kind?: "mcp" | "openapi" | "graphql" | "cli"
  readonly limit?: number
}) => decodeRegistrySearch(await request(
  "GET",
  `/v1/registry/search${query({ q: input.query, kind: input.kind, limit: input.limit })}`
))

export const discoverIntegration = async (input: {
  readonly url: string
  readonly connection?: string
}) => decodeDiscovery(await request("POST", "/v1/integrations/discover", input))

export const listConnections = async () =>
  decodeConnections(await request("GET", "/v1/connections")).connections

export const createConnection = async (input: {
  readonly integration: string
  readonly connection?: string
  readonly template?: string
  readonly values?: Readonly<Record<string, string>>
}) => decodeConnectionCreated(await request("POST", "/v1/connections", input))

export const startOAuth = async (input: {
  readonly integration: string
  readonly connection?: string
  readonly template?: string
  readonly clientId?: string
  readonly clientSecret?: string
}) => decodeOAuthSession(await request("POST", "/v1/connections/oauth", input))

export const pollOAuth = async (id: string) =>
  decodeOAuthSession(await request("GET", `/v1/connections/oauth/${segment(id)}`))

export const removeConnection = async (input: {
  readonly integration: string
  readonly name: string
}) =>
  decodeRemoved(await request(
    "DELETE",
    `/v1/connections/${segment(input.integration)}/${segment(input.name)}`
  ))

// --- clients, keys, policies ------------------------------------------------

export const listClients = async () =>
  decodeClients(await request("GET", "/v1/clients")).clients

export const fetchOverview = async () =>
  decodeOverview(await request("GET", "/v1/overview"))

export const createClient = async (input: {
  readonly name: string
  readonly policyId?: string
  readonly capabilities: ReadonlyArray<"provision_connections" | "administer_gateway">
  readonly approvalDelivery: ApprovalDelivery
}) => decodeClient(await request("POST", "/v1/clients", input))

export const updateClientSettings = async (input: {
  readonly clientId: string
  readonly capabilities: ReadonlyArray<"provision_connections" | "administer_gateway">
  readonly approvalDelivery: ApprovalDelivery
}) => decodeClient(await request(
  "POST",
  `/v1/clients/${segment(input.clientId)}/settings`,
  { capabilities: input.capabilities, approvalDelivery: input.approvalDelivery }
))

export const issueKey = async (clientId: string) =>
  decodeIssuedKey(await request("POST", `/v1/clients/${segment(clientId)}/keys`))

export const listKeys = async (clientId: string) =>
  decodeKeys(await request("GET", `/v1/clients/${segment(clientId)}/keys`)).keys

export const revokeKey = async (keyId: string) =>
  decodeRevoked(await request("POST", `/v1/keys/${segment(keyId)}/revoke`))

export const listClientTools = async (clientId: string, schemas = false) =>
  decodeEffectiveTools(await request(
    "GET",
    `/v1/clients/${segment(clientId)}/tools${query({ schemas: schemas ? "true" : undefined })}`
  )).tools

export const revokeClient = async (clientId: string) =>
  decodeRevoked(await request("POST", `/v1/clients/${segment(clientId)}/revoke`))

export const listPolicies = async () =>
  decodePolicies(await request("GET", "/v1/policies")).policies

export const getPolicy = async (policyId: string) =>
  decodePolicy(await request("GET", `/v1/policies/${segment(policyId)}`))

export const createPolicy = async (input: { readonly name: string }) =>
  decodePolicyCreated(await request("POST", "/v1/policies", input))

export const replacePolicyTools = async (input: {
  readonly policyId: string
  readonly tools: ReadonlyArray<PolicyToolInput>
}) => decodePolicyToolsReplaced(await request(
  "POST",
  `/v1/policies/${segment(input.policyId)}/tools`,
  { tools: input.tools }
))

export const clonePolicy = async (input: {
  readonly policyId: string
  readonly name: string
}) => decodePolicyToolsReplaced(await request(
  "POST",
  `/v1/policies/${segment(input.policyId)}/clone`,
  { name: input.name }
))

export const assignPolicy = async (input: {
  readonly clientId: string
  readonly policyId: string
}) => decodeClient(await request(
  "POST",
  `/v1/clients/${segment(input.clientId)}/policy`,
  { policyId: input.policyId }
))

export const listGrants = async (clientId: string) =>
  decodeGrants(await request("GET", `/v1/clients/${segment(clientId)}/connections`)).grants

export const grantConnection = async (input: {
  readonly clientId: string
  readonly integration: string
  readonly connection: string
}) => decodeGrantCreated(await request(
  "POST",
  `/v1/clients/${segment(input.clientId)}/connections`,
  { integration: input.integration, connection: input.connection }
))

export const renameGrant = async (input: {
  readonly clientId: string
  readonly grantId: string
  readonly alias: string
}) => await request(
  "POST",
  `/v1/clients/${segment(input.clientId)}/connections/${segment(input.grantId)}`,
  { alias: input.alias }
)

export const revokeGrant = async (input: {
  readonly clientId: string
  readonly grantId: string
}) => await request(
  "POST",
  `/v1/clients/${segment(input.clientId)}/connections/${segment(input.grantId)}/revoke`
)

// --- approvals, audit, upkeep -----------------------------------------------

export const listApprovals = async (status?: ApprovalStatus) =>
  decodeApprovals(await request("GET", `/v1/approvals${query({ status })}`)).approvals

export const approveApproval = async (input: {
  readonly id: string
}) =>
  decodeApprovalDecided(await request(
    "POST",
    `/v1/approvals/${segment(input.id)}/approve`,
    {}
  ))

export const denyApproval = async (input: {
  readonly id: string
}) =>
  decodeApprovalDecided(await request(
    "POST",
    `/v1/approvals/${segment(input.id)}/deny`,
    {}
  ))

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
  const response = decodeAudit(await request("GET", `/v1/audit${query({
    limit: input.limit,
    offset: input.offset,
    clientId: input.clientId,
    alias: input.alias,
    tool: input.tool,
    outcome: input.outcome,
    since: input.since
  })}`))
  return {
    records: response.records,
    total: response.total ?? response.records.length,
    limit: response.limit ?? input.limit,
    offset: response.offset ?? input.offset
  }
}

export const refreshDrift = async (integration?: string) =>
  decodeDrift(await request("POST", `/v1/drift/refresh${query({ integration })}`)).reports

// --- who is asking -----------------------------------------------------------

export type Me = ReturnType<typeof decodeMe>

export const fetchMe = async (): Promise<Me> => decodeMe(await request("GET", "/v1/auth/me"))

export const fetchAuthProviders = async () =>
  decodeAuthProviders(await request("GET", "/v1/auth/providers"))

export const signUp = async (input: {
  readonly email: string
  readonly password: string
  readonly tenantName?: string | undefined
}): Promise<void> => {
  await request("POST", "/v1/auth/signup", {
    email: input.email,
    password: input.password,
    ...whenPresent("tenantName", input.tenantName)
  })
}

export const logIn = async (input: { readonly email: string; readonly password: string }): Promise<void> => {
  await request("POST", "/v1/auth/login", input)
}

export const logOut = async (): Promise<void> => {
  await request("POST", "/v1/auth/logout")
}

// --- account self-service ----------------------------------------------------

export const changeEmail = async (input: {
  readonly email: string
  readonly password: string
}): Promise<string> =>
  decodeEmailChanged(await request("POST", "/v1/auth/email", input)).email

export const changePassword = async (input: {
  readonly currentPassword?: string
  readonly newPassword: string
}): Promise<number> =>
  decodePasswordChanged(await request("POST", "/v1/auth/password", input)).revokedSessions

/** Deleting the account is final; the caller confirms out of band. POST
 *  rather than DELETE because the confirmation password rides the body and
 *  the gateway ignores DELETE bodies. */
export const deleteAccount = async (input: {
  readonly password?: string
}): Promise<void> => {
  await request("POST", "/v1/auth/account/delete", input)
}
