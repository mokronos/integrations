import { clientHasCapability, connectionSubject, sameConnectionRef } from "./domain.ts"
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

/** Whether a presented key belongs to a live client. Says nothing about what
 *  that client may do. */
export type ClientAuthentication =
  | { readonly status: "authenticated"; readonly client: Client }
  | { readonly status: "unknown-key" }
  | { readonly status: "key-revoked" }
  | { readonly status: "client-revoked" }

/** Checks in the order they get more expensive: key exists, key live, client
 *  live. The key and its client resolve in one read — the tenant comes *from*
 *  that read — and touching last-used happens only once it is accepted. */
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

/** Resolves a presented key to what it may invoke.
 *
 * This is the single place invocation authority is decided. Everything
 * downstream — the HTTP surface, the workflow invoker, the CLI — goes through
 * it, so a call that skips it is a bug rather than a shortcut. */
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
  // The intersection ADR 0001 describes, read in two halves. The grant is the
  // client's own reach: which credential this alias names. The rule is its
  // policy's judgement about that credential's tool. Neither implies the
  // other — a policy may govern a connection this client was never granted,
  // and a grant reaches nothing the policy has not enabled.
  const grant = yield* store.findGrantByAlias(client.id, input.alias)
  const policy = yield* store.findPolicy(client.tenantId, client.policyId)
  const policyTools = policy === undefined ? [] : yield* store.listPolicyTools(policy.id)
  const policyTool = grant === undefined
    ? undefined
    : policyTools.find((candidate) =>
      candidate.enabled
      && candidate.tool === input.tool
      && sameConnectionRef(candidate.connection, grant.connection))
  // One status for every missing side of the intersection: telling them apart
  // would let a caller enumerate policy or connection state.
  if (grant === undefined || policy === undefined || policyTool === undefined) {
    return { status: "not-authorized", alias: input.alias, tool: input.tool }
  }

  return {
    status: "authorized",
    client,
    policy,
    policyTool,
    grant,
    connection: grant.connection,
    subject: connectionSubject(grant.connection) ?? null,
    decision: policyTool.decision
  }
})

export type CapabilityAuthorization =
  | { readonly status: "authorized"; readonly client: Client }
  | { readonly status: "unknown-key" }
  | { readonly status: "key-revoked" }
  | { readonly status: "client-revoked" }
  | { readonly status: "not-permitted" }

/** Whether a client holds one named non-invocation capability. Kept separate
 * from invocation policies: provisioning a connection and deciding what tools may use it
 * are deliberately different powers. */
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
