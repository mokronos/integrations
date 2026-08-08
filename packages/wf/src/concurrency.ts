export interface StepConcurrencyPolicy<I> {
  readonly key?: (input: I) => string
  readonly limit: number
}

export interface ConcurrencyLimiter {
  acquire<I>(
    stepName: string,
    policy: StepConcurrencyPolicy<I> | undefined,
    input: I,
    signal?: AbortSignal
  ): Promise<() => void>
}

interface SemaphoreState {
  active: number
  readonly queue: Array<() => void>
}

/** Creates an isolated set of step semaphores. */
export const createConcurrencyLimiter = (): ConcurrencyLimiter => {
  const policies = new WeakMap<object, Map<string, Map<string, SemaphoreState>>>()

  return {
    async acquire(stepName, policy, input, signal) {
      if (policy === undefined) return () => undefined
      const limit = policy.limit
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`Invalid concurrency limit for step ${stepName}: ${limit}`)
      }

      const key = policy.key?.(input) ?? stepName
      const steps = policies.get(policy) ?? new Map<string, Map<string, SemaphoreState>>()
      policies.set(policy, steps)
      const partitions = steps.get(stepName) ?? new Map<string, SemaphoreState>()
      steps.set(stepName, partitions)
      const state = partitions.get(key) ?? { active: 0, queue: [] }
      partitions.set(key, state)
      if (state.active >= limit) {
        await new Promise<void>((resolve, reject) => {
          const grant = () => {
            signal?.removeEventListener("abort", abort)
            resolve()
          }
          const abort = () => {
            const index = state.queue.indexOf(grant)
            if (index !== -1) state.queue.splice(index, 1)
            reject(signal?.reason ?? new Error("Concurrency wait cancelled"))
          }
          if (signal?.aborted === true) {
            abort()
            return
          }
          state.queue.push(grant)
          signal?.addEventListener("abort", abort, { once: true })
        })
      } else {
        state.active++
      }
      let released = false
      return () => {
        if (released) return
        released = true
        const next = state.queue.shift()
        if (next !== undefined) {
          // Transfer this permit directly. Keeping `active` unchanged prevents
          // a new caller from slipping in before the queued continuation runs.
          next()
          return
        }
        state.active--
        if (state.active === 0 && state.queue.length === 0) {
          partitions.delete(key)
          if (partitions.size === 0) steps.delete(stepName)
          if (steps.size === 0) policies.delete(policy)
        }
      }
    }
  }
}

/** Compatibility limiter for direct executeInMemory calls without a runtime. */
export const defaultConcurrencyLimiter = createConcurrencyLimiter()
