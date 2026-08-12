import { Schema } from "effect"
import type {
  DefinedIntegrationStep,
  StepRetryPolicy,
  SynchronousSchema
} from "./workflow-model.ts"
import { integrationSourceKey, IntegrationSource } from "./integration-contract.ts"
export type { IntegrationInvoker } from "./integration-contract.ts"
export {
  formatIntegrationSource,
  integrationSourceKey,
  IntegrationOwner,
  IntegrationSource
} from "./integration-contract.ts"

/** Kept for source snapshots that imported the old integration error schema.
 * Current integration failures are transient runtime failures instead. */
export class IntegrationError extends Schema.TaggedErrorClass<IntegrationError>()("IntegrationError", {
  message: Schema.String,
  address: Schema.String
}) {}

export const integration = <I, O>(config: {
  readonly name?: string
  readonly source: IntegrationSource
  readonly input: Schema.Codec<I>
  readonly output: Schema.Codec<O>
  readonly retry?: StepRetryPolicy
}): DefinedIntegrationStep<
  SynchronousSchema<I>,
  SynchronousSchema<O>,
  typeof Schema.Never
> => {
  const source = Schema.decodeUnknownSync(IntegrationSource)(config.source)
  return {
    kind: "integration",
    // Preserve the pre-portability activity name when loading an old source
    // snapshot so a suspended run can replay to the same durable call.
    name: config.name ?? ("address" in source
      ? `Integration:${source.address}`
      : `Integration:${integrationSourceKey(source)}`),
    input: config.input,
    output: config.output,
    errors: Schema.Never,
    source,
    ...(config.retry === undefined ? {} : { retry: config.retry })
  }
}
