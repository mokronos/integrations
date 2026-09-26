import { isJsonObject, type Json, type JsonObject, type ListedApproval } from "@integragents/contracts"

/** Newest group first, each group's calls in the order they were made. */
export const groupApprovals = (
  approvals: ReadonlyArray<ListedApproval>
): ReadonlyArray<ReadonlyArray<ListedApproval>> => {
  const groups = new Map<string, Array<ListedApproval>>()
  for (const approval of approvals) {
    const group = groups.get(approval.groupId)
    if (group === undefined) groups.set(approval.groupId, [approval])
    else group.push(approval)
  }
  return [...groups.values()].map((group) =>
    [...group].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()))
}

export type ArgumentPath = ReadonlyArray<string>

export interface ArgumentSplit {
  /** Every value all calls agree on, in the shape the calls sent it. */
  readonly shared: JsonObject
  /** The paths at least one call disagrees on. */
  readonly varying: ReadonlyArray<ArgumentPath>
}

const leaves = (value: Json, path: ArgumentPath = []): ReadonlyArray<readonly [ArgumentPath, Json]> =>
  isJsonObject(value) && Object.keys(value).length > 0
    ? Object.entries(value).flatMap(([key, nested]) => leaves(nested, [...path, key]))
    : [[path, value]]

const keyOf = (path: ArgumentPath): string => JSON.stringify(path)

const place = (target: JsonObject, path: ArgumentPath, value: Json): JsonObject => {
  const [head, ...rest] = path
  if (head === undefined) return target
  if (rest.length === 0) return { ...target, [head]: value }
  const existing = target[head]
  return { ...target, [head]: place(existing !== undefined && isJsonObject(existing) ? existing : {}, rest, value) }
}

export const splitArguments = (calls: ReadonlyArray<Json>): ArgumentSplit => {
  const flattened = calls.map((call) => new Map(leaves(call).map(([path, value]) => [keyOf(path), { path, text: JSON.stringify(value), value }])))
  const paths = new Map<string, ArgumentPath>()
  for (const call of flattened) for (const [key, leaf] of call) if (!paths.has(key)) paths.set(key, leaf.path)

  let shared: JsonObject = {}
  const varying: Array<ArgumentPath> = []
  for (const [key, path] of paths) {
    const first = flattened[0]?.get(key)
    const agreed = first !== undefined && flattened.every((call) => call.get(key)?.text === first.text)
    if (!agreed) varying.push(path)
    else if (path.length > 0) shared = place(shared, path, first.value)
  }
  return { shared, varying }
}

export const argumentAt = (value: Json, path: ArgumentPath): Json | undefined =>
  path.reduce<Json | undefined>(
    (current, key) => current !== undefined && isJsonObject(current) ? current[key] : undefined,
    value
  )
