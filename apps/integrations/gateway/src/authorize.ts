import { connectionSubject } from "./domain.ts"
import type { Alias, Authorization, ToolName } from "./domain.ts"
import { hashApiKey } from "./keys.ts"
import type { GatewayStore } from "./store.ts"

/** Resolves a presented key to what it may do, in the order the checks get
 * cheaper to fail: key exists, key live, client live, tool granted.
 *
 * This is the single place authority is decided. Everything downstream — the
 * HTTP surface, the workflow invoker, the CLI — goes through it, so a call that
 * skips it is a bug rather than a shortcut. */
export const authorizeInvocation = async (
  store: GatewayStore,
  input: {
    readonly secret: string
    readonly alias: Alias
    readonly tool: ToolName
  }
): Promise<Authorization> => {
  const key = await store.findApiKeyByHash(hashApiKey(input.secret))
  if (key === undefined) return { status: "unknown-key" }
  if (key.revokedAt !== null) return { status: "key-revoked" }

  const clients = await store.listClients()
  const client = clients.find((candidate) => candidate.id === key.clientId)
  if (client === undefined || client.revokedAt !== null) return { status: "client-revoked" }

  const grant = await store.findGrant(client.id, input.alias, input.tool)
  // One status for "no such alias" and "tool not granted" alike: telling them
  // apart would let a caller enumerate what else this tenant has connected.
  if (grant === undefined) return { status: "not-granted", alias: input.alias, tool: input.tool }

  await store.touchApiKey(key.id)
  return {
    status: "authorized",
    client,
    grant,
    connection: grant.connection,
    subject: connectionSubject(grant.connection) ?? null
  }
}

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
): Promise<
  | { readonly status: "authorized"; readonly clientId: string }
  | { readonly status: "unknown-key" }
  | { readonly status: "key-revoked" }
  | { readonly status: "client-revoked" }
  | { readonly status: "not-permitted" }
> => {
  const key = await store.findApiKeyByHash(hashApiKey(secret))
  if (key === undefined) return { status: "unknown-key" }
  if (key.revokedAt !== null) return { status: "key-revoked" }

  const clients = await store.listClients()
  const client = clients.find((candidate) => candidate.id === key.clientId)
  if (client === undefined || client.revokedAt !== null) return { status: "client-revoked" }
  if (!client.mayMutate) return { status: "not-permitted" }

  await store.touchApiKey(key.id)
  return { status: "authorized", clientId: client.id }
}
