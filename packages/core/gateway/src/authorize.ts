import {
  aliasForConnection,
  clientHasCapability,
  connectionSubject,
  sameConnectionRef
} from "./domain.ts"
import type {
  Alias,
  Authorization,
  Client,
  ClientCapability,
  ToolName
} from "./domain.ts"
import { hashApiKey } from "./keys.ts"
import { Effect } from "effect"
import type { GatewayStore } from "./store.ts"
import type { GatewayStoreError } from "./store.ts"

export type ClientAuthentication =
  | { readonly status: "authenticated"; readonly client: Client }
  | { readonly status: "unknown-key" }
  | { readonly status: "key-revoked" }
  | { readonly status: "client-revoked" }

export const authenticateClient = Effect.fn("Authorization.authenticateClient")(function*(
  store: GatewayStore,
  secret: string
): Effect.fn.Return<ClientAuthentication, GatewayStoreError> {
  const resolved = yield* store.findApiKeyByHash(hashApiKey(secret))
  if (resolved === undefined) return { status: "unknown-key" }
  if (resolved.key.revokedAt !== null) return { status: "key-revoked" }

  const client = resolved.client
  if (client.revokedAt !== null) return { status: "client-revoked" }

  yield* store.touchApiKey(resolved.key.id)
  return { status: "authenticated", client }
})

export const authorizeInvocation = Effect.fn("Authorization.authorizeInvocation")(function*(
  store: GatewayStore,
  input: {
    readonly secret: string
    readonly alias: Alias
    readonly tool: ToolName
  }
): Effect.fn.Return<Authorization, GatewayStoreError> {
  const authentication = yield* authenticateClient(store, input.secret)
  if (authentication.status !== "authenticated") return { status: authentication.status }

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
    return { status: "not-authorized", alias: input.alias, tool: input.tool }
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
  }
})

export type CapabilityAuthorization =
  | { readonly status: "authorized"; readonly client: Client }
  | { readonly status: "unknown-key" }
  | { readonly status: "key-revoked" }
  | { readonly status: "client-revoked" }
  | { readonly status: "not-permitted" }

export const authorizeClientCapability = Effect.fn("Authorization.authorizeClientCapability")(
  function*(
    store: GatewayStore,
    secret: string,
    capability: ClientCapability
  ): Effect.fn.Return<CapabilityAuthorization, GatewayStoreError> {
    const authentication = yield* authenticateClient(store, secret)
    if (authentication.status !== "authenticated") return { status: authentication.status }
    if (!clientHasCapability(authentication.client, capability)) {
      return { status: "not-permitted" }
    }
    return { status: "authorized", client: authentication.client }
  }
)
