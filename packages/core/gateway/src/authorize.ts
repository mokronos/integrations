import {
  aliasForConnection,
  ApiKey,
  AuthorizationKeyRevoked,
  AuthorizationProfileRevoked,
  AuthorizationUnknownKey,
  connectionSubject,
  isDelegationTemplate,
  Profile,
  profileHasCapability
} from "./domain.ts"
import type {
  Alias,
  Authorization,
  Authorized,
  ConnectionRef,
  ProfileCapability,
  SubjectId,
  ToolName
} from "./domain.ts"
import { hashApiKey } from "./keys.ts"
import { Crypto, Effect, Schema } from "effect"
import type { GatewayStore } from "./store.ts"
import type { GatewayStoreError } from "./store.ts"

export const AuthenticatedProfile = Schema.Struct({
  status: Schema.Literal("authenticated"),
  profile: Profile,
  key: ApiKey
})
export type AuthenticatedProfile = typeof AuthenticatedProfile.Type

export const KeyAuthentication = Schema.Union([
  AuthenticatedProfile,
  AuthorizationUnknownKey,
  AuthorizationKeyRevoked,
  AuthorizationProfileRevoked
])
export type KeyAuthentication = typeof KeyAuthentication.Type

export const authenticateKey = Effect.fn("Authorization.authenticateKey")(function*(
  store: GatewayStore,
  secret: string
): Effect.fn.Return<KeyAuthentication, GatewayStoreError, Crypto.Crypto> {
  const resolved = yield* store.findApiKeyByHash((yield* hashApiKey(secret)))
  if (resolved === undefined) {
    return { status: "unknown-key", message: "This API key is not known to the server" }
  }
  if (resolved.key.revokedAt !== null) {
    return { status: "key-revoked", message: "This API key was revoked" }
  }

  const profile = resolved.profile
  if (profile.revokedAt !== null) {
    return { status: "profile-revoked", message: "The profile this credential belongs to was revoked" }
  }

  yield* store.touchApiKey(resolved.key.id)
  return { status: "authenticated", profile, key: resolved.key } satisfies AuthenticatedProfile
})

export const authorizeInvocation = Effect.fn("Authorization.authorizeInvocation")(function*(
  store: GatewayStore,
  input: {
    readonly secret: string
    readonly alias: Alias
    readonly tool: ToolName
    readonly subject?: SubjectId
  }
): Effect.fn.Return<Authorization, GatewayStoreError, Crypto.Crypto> {
  const authentication = yield* authenticateKey(store, input.secret)
  if (authentication.status !== "authenticated") return authentication
  return yield* authorizeProfileInvocation(store, authentication.profile, input)
})

/**
 * The decision for a profile the caller has already identified, as an
 * embedding host does when the agent loop and the gateway share a process.
 *
 * A delegated tool is enabled on a template, a user-owned connection with no
 * subject. It resolves to the connection of the subject the call names, so the
 * same tool serves every user and no user reaches another's credential.
 */
export const authorizeProfileInvocation = Effect.fn("Authorization.authorizeProfileInvocation")(function*(
  store: GatewayStore,
  profile: Profile,
  input: {
    readonly alias: Alias
    readonly tool: ToolName
    readonly subject?: SubjectId
  }
): Effect.fn.Return<Authorization, GatewayStoreError> {
  if (profile.revokedAt !== null) {
    return { status: "profile-revoked", message: "The profile this credential belongs to was revoked" }
  }
  const profileTool = (yield* store.listProfileTools(profile.id)).find((candidate) =>
    candidate.tool === input.tool && aliasForConnection(candidate.connection) === input.alias)
  if (profileTool === undefined) {
    return {
      status: "not-authorized",
      alias: input.alias,
      tool: input.tool,
      message: `${input.alias}.${input.tool} is not enabled for this profile`
    }
  }

  let connection: ConnectionRef = profileTool.connection
  if (isDelegationTemplate(connection)) {
    if (input.subject === undefined) {
      return {
        status: "not-authorized",
        alias: input.alias,
        tool: input.tool,
        message: `${input.alias}.${input.tool} acts on behalf of a user; the invocation must name a subject`
      }
    }
    connection = { owner: "user", subject: input.subject, integration: connection.integration, name: connection.name }
  }

  return {
    status: "authorized",
    profile,
    profileTool,
    alias: input.alias,
    connection,
    subject: connectionSubject(connection) ?? null,
    decision: profileTool.decision
  } satisfies Authorized
})

export const CapabilityAuthorized = Schema.Struct({
  status: Schema.Literal("authorized"),
  profile: Profile,
  key: ApiKey
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
  AuthorizationProfileRevoked,
  CapabilityNotPermitted
])
export type CapabilityAuthorization = typeof CapabilityAuthorization.Type

export const authorizeProfileCapability = Effect.fn("Authorization.authorizeProfileCapability")(
  function*(
    store: GatewayStore,
    secret: string,
    capability: ProfileCapability
  ): Effect.fn.Return<CapabilityAuthorization, GatewayStoreError, Crypto.Crypto> {
    const authentication = yield* authenticateKey(store, secret)
    if (authentication.status !== "authenticated") return authentication
    if (!profileHasCapability(authentication.profile, capability)) {
      return {
        status: "not-permitted",
        message: "This credential does not hold the required permission"
      }
    }
    return { status: "authorized", profile: authentication.profile, key: authentication.key } satisfies CapabilityAuthorized
  }
)
