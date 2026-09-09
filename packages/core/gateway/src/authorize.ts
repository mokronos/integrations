import {
  aliasForConnection,
  AuthorizationClientRevoked,
  AuthorizationKeyRevoked,
  AuthorizationUnknownKey,
  clientHasCapability,
  Client,
  connectionSubject,
  sameConnectionRef
} from "./domain.ts"
import type {
  Alias,
  Authorization,
  Authorized,
  ClientCapability,
  ToolName
} from "./domain.ts"
import { hashApiKey } from "./keys.ts"
import { Crypto, Effect, Schema } from "effect"
import type { GatewayStore } from "./store.ts"
import type { GatewayStoreError } from "./store.ts"

export const AuthenticatedClient = Schema.Struct({
  status: Schema.Literal("authenticated"),
  client: Client
})
export type AuthenticatedClient = typeof AuthenticatedClient.Type

export const ClientAuthentication = Schema.Union([
  AuthenticatedClient,
  AuthorizationUnknownKey,
  AuthorizationKeyRevoked,
  AuthorizationClientRevoked
])
export type ClientAuthentication = typeof ClientAuthentication.Type

export const authenticateClient = Effect.fn("Authorization.authenticateClient")(function*(
  store: GatewayStore,
  secret: string
): Effect.fn.Return<ClientAuthentication, GatewayStoreError, Crypto.Crypto> {
  const resolved = yield* store.findApiKeyByHash((yield* hashApiKey(secret)))
  if (resolved === undefined) {
    return { status: "unknown-key", message: "This API key is not known to the server" }
  }
  if (resolved.key.revokedAt !== null) {
    return { status: "key-revoked", message: "This API key was revoked" }
  }

  const client = resolved.client
  if (client.revokedAt !== null) {
    return { status: "client-revoked", message: "The client this key belongs to was revoked" }
  }

  yield* store.touchApiKey(resolved.key.id)
  return { status: "authenticated", client } satisfies AuthenticatedClient
})

export const authorizeInvocation = Effect.fn("Authorization.authorizeInvocation")(function*(
  store: GatewayStore,
  input: {
    readonly secret: string
    readonly alias: Alias
    readonly tool: ToolName
  }
): Effect.fn.Return<Authorization, GatewayStoreError, Crypto.Crypto> {
  const authentication = yield* authenticateClient(store, input.secret)
  if (authentication.status !== "authenticated") return authentication

  const client = authentication.client
  const [accessProfile, approvalPolicy] = yield* Effect.all([
    store.findAccessProfile(client.tenantId, client.accessProfileId),
    store.findApprovalPolicy(client.tenantId, client.approvalPolicyId)
  ])
  const profileTools = accessProfile === undefined
    ? []
    : yield* store.listAccessProfileTools(accessProfile.id)
  const accessProfileTool = profileTools.find((candidate) =>
    candidate.tool === input.tool && aliasForConnection(candidate.connection) === input.alias)
  const approvalPolicyTools = approvalPolicy === undefined
    ? []
    : yield* store.listApprovalPolicyTools(approvalPolicy.id)
  const approvalPolicyTool = accessProfileTool === undefined
    ? undefined
    : approvalPolicyTools.find((candidate) =>
      candidate.tool === input.tool
      && sameConnectionRef(candidate.connection, accessProfileTool.connection))
  if (
    accessProfile === undefined
    || accessProfileTool === undefined
    || approvalPolicy === undefined
    || approvalPolicyTool === undefined
  ) {
    return {
      status: "not-authorized",
      alias: input.alias,
      tool: input.tool,
      message: `${input.alias}.${input.tool} is not authorized for this client`
    }
  }

  return {
    status: "authorized",
    client,
    accessProfile,
    accessProfileTool,
    approvalPolicy,
    approvalPolicyTool,
    alias: input.alias,
    connection: accessProfileTool.connection,
    subject: connectionSubject(accessProfileTool.connection) ?? null,
    decision: approvalPolicyTool.decision
  } satisfies Authorized
})

export const CapabilityAuthorized = Schema.Struct({
  status: Schema.Literal("authorized"),
  client: Client
})
export type CapabilityAuthorized = typeof CapabilityAuthorized.Type

export const CapabilityNotPermitted = Schema.Struct({
  status: Schema.Literal("not-permitted"),
  message: Schema.Literal("This credential does not hold the required permission")
})
export type CapabilityNotPermitted = typeof CapabilityNotPermitted.Type

export const CapabilityAuthorization = Schema.Union([
  CapabilityAuthorized,
  AuthorizationUnknownKey,
  AuthorizationKeyRevoked,
  AuthorizationClientRevoked,
  CapabilityNotPermitted
])
export type CapabilityAuthorization = typeof CapabilityAuthorization.Type

export const authorizeClientCapability = Effect.fn("Authorization.authorizeClientCapability")(
  function*(
    store: GatewayStore,
    secret: string,
    capability: ClientCapability
  ): Effect.fn.Return<CapabilityAuthorization, GatewayStoreError, Crypto.Crypto> {
    const authentication = yield* authenticateClient(store, secret)
    if (authentication.status !== "authenticated") return authentication
    if (!clientHasCapability(authentication.client, capability)) {
      return {
        status: "not-permitted",
        message: "This credential does not hold the required permission"
      }
    }
    return { status: "authorized", client: authentication.client } satisfies CapabilityAuthorized
  }
)
