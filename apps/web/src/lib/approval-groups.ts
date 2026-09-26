import { argumentPattern, isJsonObject, type ArgumentPath, type Json, type JsonObject, type ListedApproval } from "@integragents/contracts"

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

export interface ArgumentSplit {
  /** Every value all calls agree on, in the shape the calls sent it. */
  readonly shared: JsonObject
  /** The paths at least one call disagrees on. */
  readonly varying: ReadonlyArray<ArgumentPath>
}

const place = (target: JsonObject, path: ArgumentPath, value: Json): JsonObject => {
  const [head, ...rest] = path
  if (head === undefined) return target
  if (rest.length === 0) return { ...target, [head]: value }
  const existing = target[head]
  return { ...target, [head]: place(existing !== undefined && isJsonObject(existing) ? existing : {}, rest, value) }
}

export const pinnedObject = (pinned: ReadonlyArray<{ readonly path: ArgumentPath; readonly value: Json }>): JsonObject =>
  pinned.reduce<JsonObject>((shared, entry) => place(shared, entry.path, entry.value), {})

export const splitArguments = (calls: ReadonlyArray<Json>): ArgumentSplit => {
  const { pinned, free } = argumentPattern(calls)
  return { shared: pinnedObject(pinned), varying: free }
}

export const argumentAt = (value: Json, path: ArgumentPath): Json | undefined =>
  path.reduce<Json | undefined>(
    (current, key) => current !== undefined && isJsonObject(current) ? current[key] : undefined,
    value
  )
