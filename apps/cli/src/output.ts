import { whenTrue } from "@mokronos/contracts"
import { Effect, Schema } from "effect"

export const largeListing = 50

export interface Page<A> {
  readonly items: ReadonlyArray<A>
  readonly count: number
  readonly limit: number | undefined
  readonly offset: number
}

export interface Window {
  readonly limit: number | undefined
  readonly offset: number | undefined
}

export const page = <A>(items: ReadonlyArray<A>, window: Window): Page<A> => {
  const offset = Math.max(0, window.offset ?? 0)
  const limited = window.limit === undefined
    ? items.slice(offset)
    : items.slice(offset, offset + Math.max(0, window.limit))
  return { items: limited, count: items.length, limit: window.limit, offset }
}

export const pageFields = <A>(result: Page<A>, narrowing: string) => {
  const windowed = result.limit !== undefined || result.offset > 0
  return {
    count: result.count,
    ...whenTrue(windowed, () => ({ showing: result.items.length, offset: result.offset })),
    ...whenTrue(
      result.count > largeListing && !windowed,
      () => ({ hint: `${result.count} rows — ${narrowing}, or pipe this into jq` })
    )
  }
}

export type JsonEncodable =
  | Schema.Json
  | undefined
  | Date
  | ReadonlyArray<JsonEncodable>
  | { readonly [key: string]: JsonEncodable }

export const jsonOutput = (value: JsonEncodable, verbose: boolean): string =>
  JSON.stringify(value, null, verbose ? 2 : undefined)

export const inline = (value: string, limit: number): string => {
  const collapsed = value.replace(/\s+/g, " ").trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`
}

export const writeStdoutLine = (text: string): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    process.stdout.write(`${text}\n`, (error) => {
      resume(error === undefined || error === null ? Effect.void : Effect.die(error))
    })
  })

export const withNext = (
  body: Record<string, typeof Schema.Json.Type>,
  next: string | undefined
): Record<string, typeof Schema.Json.Type> => next === undefined ? body : { ...body, next }
