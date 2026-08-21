import { connectionSubject } from "./domain.ts"
import type { Alias, Authorization, Client, ToolName } from "./domain.ts"
import { hashApiKey } from "./keys.ts"
import type { GatewayStore } from "./store.ts"

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
export const authenticateClient = async (
  store: GatewayStore,
  secret: string
): Promise<ClientAuthentication> => {
  const resolved = await store.findApiKeyByHash(hashApiKey(secret))
  if (resolved === undefined) return { status: "unknown-key" }
  if (resolved.key.revokedAt !== null) return { status: "key-revoked" }

  const client = resolved.client
  if (client.revokedAt !== null) return { status: "client-revoked" }

  await store.touchApiKey(resolved.key.id)
  return { status: "authenticated", client }
}

/** Resolves a presented key to what it may invoke.
 *
 * This is the single place invocation authority is decided. Everything
 * downstream — the HTTP surface, the workflow invoker, the CLI — goes through
 * it, so a call that skips it is a bug rather than a shortcut. */
export const authorizeInvocation = async (
  store: GatewayStore,
  input: {
    readonly secret: string
    readonly alias: Alias
    readonly tool: ToolName
  }
): Promise<Authorization> => {
  const authentication = await authenticateClient(store, input.secret)
  if (authentication.status !== "authenticated") return { status: authentication.status }

  const client = authentication.client
  const grant = await store.findGrant(client.id, input.alias, input.tool)
  // One status for "no such alias" and "tool not granted" alike: telling them
  // apart would let a caller enumerate what else this tenant has connected.
  if (grant === undefined) return { status: "not-granted", alias: input.alias, tool: input.tool }

  return {
    status: "authorized",
    client,
    grant,
    connection: grant.connection,
    subject: connectionSubject(grant.connection) ?? null
  }
}

export type MutationAuthorization =
  | { readonly status: "authorized"; readonly client: Client }
  | { readonly status: "unknown-key" }
  | { readonly status: "key-revoked" }
  | { readonly status: "client-revoked" }
  | { readonly status: "not-permitted" }

/** Whether a key may mutate the catalog, connections, grants, or policy.
 *
 * Separate from {@link authorizeInvocation} because it asks a different
 * question: not "may you invoke this tool" but "may you change what is
 * invocable". A runtime approval gate cannot substitute for this — the point is
 * that the request is never makeable, so there is no prompt for a tired human
 * to wave through. */
export const authorizeMutation = async (
  store: GatewayStore,
  secret: string
): Promise<MutationAuthorization> => {
  const authentication = await authenticateClient(store, secret)
  if (authentication.status !== "authenticated") return { status: authentication.status }
  if (!authentication.client.mayMutate) return { status: "not-permitted" }
  return { status: "authorized", client: authentication.client }
}
