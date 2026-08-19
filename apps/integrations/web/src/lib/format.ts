/** A timestamp a human reads at a glance, not one they parse. */
export const when = (value: Date | string | null | undefined): string => {
  if (value === null || value === undefined) return "—"
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  })
}

/** How long until something stops being true. Approvals expire, and "in 3h" is
 *  the number that decides whether you act now. */
export const until = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value)
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  if (Number.isNaN(seconds)) return "—"
  if (seconds <= 0) return "expired"
  if (seconds < 60) return `in ${seconds}s`
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`
  if (seconds < 86_400) return `in ${Math.round(seconds / 3600)}h`
  return `in ${Math.round(seconds / 86_400)}d`
}

export const pluralise = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`

/** Reads a connection back as the address the rest of the system uses. */
export const connectionLabel = (connection: {
  readonly owner: "org" | "user"
  readonly integration: string
  readonly name: string
  readonly subject?: string
}): string =>
  connection.owner === "user" && connection.subject !== undefined
    ? `user:${connection.subject}/${connection.integration}/${connection.name}`
    : `org/${connection.integration}/${connection.name}`
