/**
 * Where compiled tools deliberately depart from what the OpenAPI document
 * says. Everything outside this directory follows the document; each
 * adaptation here states the constraint it works around, so it can be deleted
 * once that constraint is gone.
 */
import type { OperationInput } from "../operation-inputs.ts"
import { dropCredentialParameters } from "./credential-parameters.ts"
import { dropGoogleSystemParameters } from "./google-system-parameters.ts"
import { modelSafeArgumentNames } from "./model-safe-argument-names.ts"
import type { AdaptationContext } from "./context.ts"

export type { AdaptationContext } from "./context.ts"

const adaptations: ReadonlyArray<
  (inputs: ReadonlyArray<OperationInput>, context: AdaptationContext) => ReadonlyArray<OperationInput>
> = [
  dropCredentialParameters,
  dropGoogleSystemParameters,
  modelSafeArgumentNames
]

export const adaptInputs = (
  inputs: ReadonlyArray<OperationInput>,
  context: AdaptationContext
): ReadonlyArray<OperationInput> =>
  adaptations.reduce((current, adapt) => adapt(current, context), inputs)
