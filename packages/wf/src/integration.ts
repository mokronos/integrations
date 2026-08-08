import { Context, Schema } from "effect"
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

type JsonValue = typeof Json.Type

export interface IntegrationInvoker {
  readonly invoke: (address: string, input: JsonValue) => Promise<JsonValue>
}

export const currentIntegrationInvoker = Context.Reference<IntegrationInvoker | undefined>(
  "@mokronos/wfkit/IntegrationInvoker",
  { defaultValue: () => undefined }
)

const executionIntegrationInvokers = new Map<string, IntegrationInvoker>()

export const setExecutionIntegrationInvoker = (
  executionId: string,
  invoker: IntegrationInvoker
): void => {
  executionIntegrationInvokers.set(executionId, invoker)
}

export const getExecutionIntegrationInvoker = (
  executionId: string
): IntegrationInvoker | undefined => executionIntegrationInvokers.get(executionId)

export const removeExecutionIntegrationInvoker = (executionId: string): void => {
  executionIntegrationInvokers.delete(executionId)
}

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
  execute: async (input, step) => {
    try {
      const jsonInput = Schema.decodeUnknownSync(Json)(input)
      const result = await step.invokeIntegration(config.source.address, jsonInput)
      return await Schema.decodeUnknownPromise(config.output)(result)
    } catch (cause) {
      throw new IntegrationError({
        message: cause instanceof Error ? cause.message : String(cause),
        address: config.source.address
      })
    }
  }
})
