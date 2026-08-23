import { Schema } from "effect"
import { whenPresent, whenPresentFields } from "./optional.ts"
import type { JsonEncodable } from "./optional.ts"
import { Predicate } from "effect"
import {
  decodeApprovalDecided,
  decodeApprovals,
  decodeAudit,
  decodeClient,
  decodeClients,
  decodeConnectionCreated,
  decodeConnections,
  decodeDiscovery,
  decodeDrift,
  decodeGrant,
  decodeGrantedTools,
  decodeGrants,
  decodeIntegrations,
  decodeInvocation,
  decodeIssuedKey,
  decodeEmailChanged,
  decodeMe,
  decodePasswordChanged,
  decodeKeys,
  decodeMaintenance,
  decodeOAuthSession,
  decodeRemoved,
  decodeRegistrySearch,
  decodeRevoked,
  decodeTool,
  decodeTools,
  decodeValidation
} from "@/lib/schemas"
import type { ApprovalStatus, GrantDecision } from "@/lib/schemas"

/** The gateway's API, as the control plane uses it.
 *
 * There is no API key here and no place to put one: the page is served by the
 * gateway, so the browser's own same-origin request is what authenticates it.
 * See `apps/integrations/gateway/src/http/loopback.ts` for why that is safe and
 * where it stops being safe.
 */

/** A connection as a request body spells it: the same union as the domain's
 * `ConnectionRef`, minus the brands, because branding is a property of decoded
 * values and this is what goes out on the wire.
 *
 * A decoded `ConnectionRef` is assignable to this, so a grant read back from
 * the gateway can be handed straight to `createGrant` without a cast. */
export type ConnectionRefInput =
  | {
    readonly owner: "org"
    readonly integration: string
    readonly name: string
  }
  | {
    readonly owner: "user"
    readonly subject: string
    readonly integration: string
    readonly name: string
  }

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

export const invokeTool = async (input: {
  readonly address: string
  readonly arguments: JsonEncodable
}) => decodeInvocation(await request("POST", "/v1/tools/invoke", input))

// --- clients, keys, grants --------------------------------------------------

export const listClients = async () =>
  decodeClients(await request("GET", "/v1/clients")).clients

export const createClient = async (input: {
  readonly name: string
  readonly capabilities: ReadonlyArray<"provision_connections" | "administer_gateway">
}) => decodeClient(await request("POST", "/v1/clients", input))

export const issueKey = async (clientId: string) =>
  decodeIssuedKey(await request("POST", `/v1/clients/${segment(clientId)}/keys`))

export const listKeys = async (clientId: string) =>
  decodeKeys(await request("GET", `/v1/clients/${segment(clientId)}/keys`)).keys

export const revokeKey = async (keyId: string) =>
  decodeRevoked(await request("POST", `/v1/keys/${segment(keyId)}/revoke`))

export const listClientTools = async (clientId: string, schemas = false) =>
  decodeGrantedTools(await request(
    "GET",
    `/v1/clients/${segment(clientId)}/tools${query({ schemas: schemas ? "true" : undefined })}`
  )).tools

export const revokeClient = async (clientId: string) =>
  decodeRevoked(await request("POST", `/v1/clients/${segment(clientId)}/revoke`))

export const listGrants = async (clientId: string) =>
  decodeGrants(await request("GET", `/v1/grants${query({ clientId })}`)).grants

export const createGrant = async (input: {
  readonly clientId: string
  readonly alias: string
  readonly tool: string
  readonly connection: ConnectionRefInput
  readonly decision: GrantDecision
}) => decodeGrant(await request("POST", "/v1/grants", input))

export const revokeGrant = async (grantId: string) =>
  decodeRevoked(await request("POST", `/v1/grants/${segment(grantId)}/revoke`))

// --- approvals, audit, upkeep -----------------------------------------------

export const listApprovals = async (status?: ApprovalStatus) =>
  decodeApprovals(await request("GET", `/v1/approvals${query({ status })}`)).approvals

export const approveApproval = async (input: {
  readonly id: string
  readonly decidedBy?: string
}) =>
  decodeApprovalDecided(await request(
    "POST",
    `/v1/approvals/${segment(input.id)}/approve`,
    { decidedBy: input.decidedBy }
  ))

export const denyApproval = async (input: {
  readonly id: string
  readonly decidedBy?: string
}) =>
  decodeApprovalDecided(await request(
    "POST",
    `/v1/approvals/${segment(input.id)}/deny`,
    { decidedBy: input.decidedBy }
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

export const validateNode = async (input: {
  readonly node: JsonEncodable
  readonly live: boolean
}) => decodeValidation(await request("POST", "/v1/validate", input))

export const refreshDrift = async (integration?: string) =>
  decodeDrift(await request("POST", `/v1/drift/refresh${query({ integration })}`)).reports

export const runMaintenance = async () =>
  decodeMaintenance(await request("POST", "/v1/maintenance"))

// --- who is asking -----------------------------------------------------------

export type Me = ReturnType<typeof decodeMe>

export const fetchMe = async (): Promise<Me> => decodeMe(await request("GET", "/v1/auth/me"))

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
  readonly currentPassword: string
  readonly newPassword: string
}): Promise<number> =>
  decodePasswordChanged(await request("POST", "/v1/auth/password", input)).revokedSessions

/** Deleting the account is final; the caller confirms out of band. POST
 *  rather than DELETE because the confirmation password rides the body and
 *  the gateway ignores DELETE bodies. */
export const deleteAccount = async (input: {
  readonly password: string
}): Promise<void> => {
  await request("POST", "/v1/auth/account/delete", input)
}
