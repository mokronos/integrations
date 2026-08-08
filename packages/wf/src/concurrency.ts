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
  const semaphores = new Map<string, SemaphoreState>()

  return {
    async acquire(stepName, policy, input) {
      const limit = policy?.limit
      if (limit === undefined) return () => undefined
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`Invalid concurrency limit for step ${stepName}: ${limit}`)
      }

      const key = policy?.key?.(input) ?? stepName
      const semaphoreKey = `${stepName}\0${key}`
      const state = semaphores.get(semaphoreKey) ?? { active: 0, queue: [] }
      semaphores.set(semaphoreKey, state)
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
          semaphores.delete(semaphoreKey)
        }
      }
    }
  }
}

/** Compatibility limiter for direct executeInMemory calls without a runtime. */
export const defaultConcurrencyLimiter = createConcurrencyLimiter()
