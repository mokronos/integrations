import { Effect } from "effect"

/** Progressive output, on by default.
 *
 * `9f098b9` established this across the workflow CLI: bounded listings, a
 * `Showing N of M` hint, compact JSON, and truncated detail, with `--verbose`
 * for everything. `16a656b` reverted it out of the integrations commands while
 * doing unrelated executor work. It is reintroduced here rather than merged
 * back into a command tree this package replaces.
 *
 * The reason it matters more here than in a typical CLI: the primary reader is
 * an agent with a finite context window, and an unbounded tool listing can be
 * tens of thousands of tokens. */
export const defaultPageSize = 10
export const defaultDetailLimit = 800

export const visibleItems = <A>(
  items: ReadonlyArray<A>,
  verbose: boolean,
  pageSize = defaultPageSize
): ReadonlyArray<A> => verbose ? items : items.slice(0, pageSize)

export const moreHint = (shown: number, total: number): string | undefined =>
  shown < total ? `Showing ${shown} of ${total}. Rerun with --verbose for all.` : undefined

/** JSON is compact unless verbose, because an agent pays for whitespace. */
export const jsonOutput = (value: unknown, verbose: boolean): string =>
  JSON.stringify(value, null, verbose ? 2 : undefined)

export const truncate = (value: string, verbose: boolean, limit = defaultDetailLimit): string =>
  verbose || value.length <= limit
    ? value
    : `${value.slice(0, limit)}… (+${value.length - limit} chars)`

export const inline = (value: string, limit: number): string => {
  const collapsed = value.replace(/\s+/g, " ").trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`
}

/** Awaits the write rather than firing and forgetting, so a large result is
 *  fully drained before the process exits. */
export const writeStdoutLine = (text: string): Effect.Effect<void> =>
  Effect.promise(() =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(`${text}\n`, (error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    })
  )

/** Listings append the command that follows, so an agent does not have to guess
 *  the next step. Established by the original `wf i` surface. */
export const withNext = (
  body: Record<string, unknown>,
  next: string | undefined
): Record<string, unknown> => next === undefined ? body : { ...body, next }
