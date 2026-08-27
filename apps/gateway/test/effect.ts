import { Effect } from "effect"

export const run = <A, E>(value: Effect.Effect<A, E> | PromiseLike<A> | A): PromiseLike<A> | A =>
  Effect.isEffect(value) ? Effect.runPromise(value) : value

export const runAll = <A, E>(effects: Iterable<Effect.Effect<A, E>>): Promise<ReadonlyArray<A>> =>
  Effect.runPromise(Effect.all(effects))
