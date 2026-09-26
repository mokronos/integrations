import { Schema } from "effect"
import { canonicalJson, isJsonObject, type Json } from "./json.ts"

/** Where a value sits inside a call's arguments, one object key per step. */
export const ArgumentPath = Schema.Array(Schema.String)
export type ArgumentPath = typeof ArgumentPath.Type

export const PinnedArgument = Schema.Struct({ path: ArgumentPath, value: Schema.Json })
export type PinnedArgument = typeof PinnedArgument.Type

/**
 * Which calls a saved approval covers: every pinned value exactly, any value
 * under a free path, and nothing else.
 */
export const ArgumentPattern = Schema.Struct({
  pinned: Schema.Array(PinnedArgument),
  free: Schema.Array(ArgumentPath)
})
export type ArgumentPattern = typeof ArgumentPattern.Type

/** Objects are walked into; arrays, scalars and empty objects are compared whole. */
export const argumentLeaves = (value: Json, path: ArgumentPath = []): ReadonlyArray<PinnedArgument> =>
  isJsonObject(value) && Object.keys(value).length > 0
    ? Object.entries(value).flatMap(([key, nested]) => argumentLeaves(nested, [...path, key]))
    : [{ path, value }]

const pathKey = (path: ArgumentPath): string => JSON.stringify(path)

const startsWith = (path: ArgumentPath, prefix: ArgumentPath): boolean =>
  prefix.length <= path.length && prefix.every((key, index) => path[index] === key)

/** What a set of calls agrees on is pinned; a path any of them disagrees on is free. */
export const argumentPattern = (calls: ReadonlyArray<Json>): ArgumentPattern => {
  const flattened = calls.map((call) => new Map(argumentLeaves(call).map((leaf) => [pathKey(leaf.path), leaf])))
  const paths = new Map<string, ArgumentPath>()
  for (const call of flattened) for (const [key, leaf] of call) if (!paths.has(key)) paths.set(key, leaf.path)
  const pinned: Array<PinnedArgument> = []
  const free: Array<ArgumentPath> = []
  for (const [key, path] of paths) {
    const first = flattened[0]?.get(key)
    const agreed = first !== undefined
      && flattened.every((call) => {
        const leaf = call.get(key)
        return leaf !== undefined && canonicalJson(leaf.value) === canonicalJson(first.value)
      })
    if (agreed) pinned.push(first)
    else if (path.length > 0) free.push(path)
  }
  return { pinned, free }
}

/** A pattern is only well formed when no path is named twice and nothing pinned sits under a free path. */
export const patternProblem = (pattern: ArgumentPattern): string | undefined => {
  const all = [...pattern.pinned.map((entry) => entry.path), ...pattern.free]
  if (new Set(all.map(pathKey)).size !== all.length) return "A field is listed more than once"
  if (pattern.free.some((path) => path.length === 0)) return "The whole argument object cannot be left open"
  const shadowed = pattern.pinned.find((entry) => pattern.free.some((free) => startsWith(entry.path, free)))
  return shadowed === undefined ? undefined : `${shadowed.path.join(".")} is both pinned and open`
}

export const matchesPattern = (pattern: ArgumentPattern, call: Json): boolean => {
  const leaves = new Map(argumentLeaves(call).map((leaf) => [pathKey(leaf.path), leaf]))
  const pinned = new Map(pattern.pinned.map((entry) => [pathKey(entry.path), entry]))
  const everyPinnedHolds = pattern.pinned.every((entry) => {
    const leaf = leaves.get(pathKey(entry.path))
    return leaf !== undefined && canonicalJson(leaf.value) === canonicalJson(entry.value)
  })
  const nothingElse = [...leaves.values()].every((leaf) =>
    pinned.has(pathKey(leaf.path)) || pattern.free.some((free) => startsWith(leaf.path, free)))
  return everyPinnedHolds && nothingElse
}
