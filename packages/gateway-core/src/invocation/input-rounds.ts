import { AuditApproval, canonicalJson, ProfileId, ToolAddress, whenPresent } from "@integragents/contracts"
import { Clock, Crypto, Duration, Effect, Option, Schema } from "effect"
import { sha256Hex } from "../keys.ts"
import type { SealedStateStore } from "../store/index.ts"
import type { Json } from "@integragents/contracts"

/** Long enough for a human to answer the form a round puts to them. */
const roundLifetime = Duration.minutes(30)

/** How a call that needed a human's approval got it, carried so later rounds neither ask again nor forget it. */
export const RoundApproval = Schema.Struct({
  approval: AuditApproval,
  message: Schema.NullOr(Schema.String)
})
export type RoundApproval = typeof RoundApproval.Type

/**
 * What a caller hands back to continue a tool's input round. It travels
 * through the caller sealed, so the caller can neither read the upstream
 * server's state nor alter which call, arguments or approval it names.
 */
const RoundState = Schema.Struct({
  profileId: ProfileId,
  tool: ToolAddress,
  argumentsHash: Schema.String,
  approval: Schema.NullOr(RoundApproval),
  upstream: Schema.optional(Schema.String),
  expiresAt: Schema.Number
})
type RoundState = typeof RoundState.Type

const RoundStateJson = Schema.fromJsonString(RoundState)
const encodeRoundState = Schema.encodeSync(RoundStateJson)
const decodeRoundState = Schema.decodeUnknownOption(RoundStateJson)

/** The exact call a round belongs to. */
export interface RoundCall {
  readonly profileId: ProfileId
  readonly tool: ToolAddress
  readonly arguments: Json
}

const argumentsHash = (value: Json): Effect.Effect<string, never, Crypto.Crypto> => sha256Hex(canonicalJson(value))

export const sealRound = Effect.fn("InputRounds.seal")(function* (
  store: SealedStateStore,
  call: RoundCall,
  round: { readonly approval: RoundApproval | null; readonly upstream: string | undefined }
) {
  const state: RoundState = {
    profileId: call.profileId,
    tool: call.tool,
    argumentsHash: yield* argumentsHash(call.arguments),
    approval: round.approval,
    ...whenPresent("upstream", round.upstream),
    expiresAt: (yield* Clock.currentTimeMillis) + Duration.toMillis(roundLifetime)
  }
  return yield* store.sealState(encodeRoundState(state))
})

/** A round's state, when this gateway sealed it, it is still good, and it names exactly this call. */
export const openRound = Effect.fn("InputRounds.open")(function* (
  store: SealedStateStore,
  token: string,
  call: RoundCall
): Effect.fn.Return<Option.Option<RoundState>, never, Crypto.Crypto> {
  const state = Option.flatMap(yield* store.openState(token), decodeRoundState)
  if (Option.isNone(state)) return Option.none()
  const now = yield* Clock.currentTimeMillis
  const hash = yield* argumentsHash(call.arguments)
  return Option.filter(
    state,
    (opened) =>
      opened.profileId === call.profileId &&
      opened.tool === call.tool &&
      opened.argumentsHash === hash &&
      opened.expiresAt > now
  )
})
