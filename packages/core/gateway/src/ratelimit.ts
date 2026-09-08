export interface RateLimitDecision {
  readonly allowed: boolean
  readonly retryAfterSeconds: number
}

export interface RateLimiter {
  take(key: string, nowMs?: number): RateLimitDecision
  reset(): void
}

export interface RateLimiterOptions {
  readonly limit: number
  readonly windowMs: number
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
