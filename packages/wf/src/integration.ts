import { Schema } from "effect"
import type { Step, StepRetryPolicy } from "./core.ts"

export const IntegrationSource = Schema.Struct({
  kind: Schema.Literal("executor"),
  address: Schema.String.pipe(
    Schema.refine(
      (value): value is string => /^tools\.[^.]+\.(org|user)\.[^.]+\..+$/.test(value)
    )
  )
})
export type IntegrationSource = typeof IntegrationSource.Type

export class IntegrationError extends Schema.TaggedErrorClass<IntegrationError>()("IntegrationError", {
  message: Schema.String,
  address: Schema.String
}) {}

const IntegrationErrorSchema = IntegrationError
const Json = Schema.Json

export const integration = <I, O>(config: {
  readonly name?: string
  readonly source: IntegrationSource
  readonly input: Schema.Codec<I>
  readonly output: Schema.Codec<O>
  readonly retry?: StepRetryPolicy
}): Step<I, O, IntegrationError> => ({
  name: config.name ?? `Integration:${config.source.address}`,
  input: config.input,
  output: config.output,
  errors: IntegrationErrorSchema,
  ...(config.retry === undefined ? {} : { retry: config.retry }),
  execute: async (input) => {
    try {
      const jsonInput = Schema.decodeUnknownSync(Json)(input)
      const { ExecutorToolAddress, executeExecutorTool } = await import("./executor.ts")
      const result = await executeExecutorTool(
        ExecutorToolAddress.make(config.source.address),
        jsonInput
      )
      return await Schema.decodeUnknownPromise(config.output)(result)
    } catch (cause) {
      throw new IntegrationError({
        message: cause instanceof Error ? cause.message : String(cause),
        address: config.source.address
      })
    }
  }
})
