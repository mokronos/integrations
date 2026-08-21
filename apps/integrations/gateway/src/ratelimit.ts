/** Fixed-window rate limiting over an in-memory counter.
 *
 * Deliberately modest: one process, no shared state, no distributed claims.
 * Its job is turning an accidental loop or a credential-guessing script into a
 * clean 429 instead of a database under load — not to survive a determined
 * distributed attack, which is what the edge/proxy layer in front of a hosted
 * gateway is for.
 *
 * Windows are anchored per key at first use, so no global clock alignment is
 * needed and the maths is trivial to reason about: within `windowMs` of a
 * key's window start, at most `limit` requests are allowed. */
export interface RateLimitDecision {
  readonly allowed: boolean
  /** Seconds until the current window closes; meaningful only when refused. */
  readonly retryAfterSeconds: number
}

export interface RateLimiter {
  take(key: string, nowMs?: number): RateLimitDecision
  /** Drops every counter. Used between tests, and nowhere else. */
  reset(): void
}

export interface RateLimiterOptions {
  readonly limit: number
  readonly windowMs: number
  /** Buckets held beyond their window are pruned lazily; this bounds how many
   *  stale entries may accumulate before a sweep runs. */
  readonly pruneAfter?: number
}

export const createRateLimiter = (options: RateLimiterOptions): RateLimiter => {
  const counters = new Map<string, { readonly start: number; count: number }>()
  const pruneAfter = options.pruneAfter ?? 4096

  const prune = (nowMs: number): void => {
    for (const [key, counter] of counters) {
      if (nowMs - counter.start >= options.windowMs) counters.delete(key)
    }
  }

  return {
    take: (key, nowMs = Date.now()) => {
      if (counters.size >= pruneAfter) prune(nowMs)
      const existing = counters.get(key)
      if (existing === undefined || nowMs - existing.start >= options.windowMs) {
        counters.set(key, { start: nowMs, count: 1 })
        return { allowed: true, retryAfterSeconds: 0 }
      }
      if (existing.count < options.limit) {
        existing.count += 1
        return { allowed: true, retryAfterSeconds: 0 }
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.start + options.windowMs - nowMs) / 1000))
      }
    },
    reset: () => counters.clear()
  }
}
