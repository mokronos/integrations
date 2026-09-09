import { Crypto, Effect } from "effect"
import { webCryptoLayer } from "@mokronos/contracts"

/**
 * Identifiers and secrets are minted through the Crypto service, so the test
 * runner carries the same platform implementation the gateway runs on. A test
 * that wants to pin what gets minted provides its own layer instead.
 */
export const run = <A, E>(
  value: Effect.Effect<A, E, Crypto.Crypto> | PromiseLike<A> | A
): PromiseLike<A> | A =>
  Effect.isEffect(value)
    ? Effect.runPromise(Effect.provide(value, webCryptoLayer))
    : value

export const runAll = <A, E>(
  effects: Iterable<Effect.Effect<A, E, Crypto.Crypto>>
): Promise<ReadonlyArray<A>> =>
  Effect.runPromise(Effect.provide(Effect.all(effects), webCryptoLayer))
