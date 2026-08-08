export interface StepConcurrencyPolicy<I> {
  readonly key?: (input: I) => string
  readonly limit: number
}

export interface ConcurrencyLimiter {
  acquire<I>(
    stepName: string,
    policy: StepConcurrencyPolicy<I> | undefined,
    input: I
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
    async acquire(stepName, policy, input) {
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
        await new Promise<void>((resolve) => state.queue.push(resolve))
      }

      state.active++
      let released = false
      return () => {
        if (released) return
        released = true
        state.active--
        state.queue.shift()?.()
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
