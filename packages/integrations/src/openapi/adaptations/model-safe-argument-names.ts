/**
 * OpenAPI allows any parameter name, but model providers restrict tool input
 * property keys; Anthropic requires `^[a-zA-Z0-9_.-]{1,64}$` and drops the
 * whole tool otherwise. The argument is renamed; the request still uses the
 * name the document declares.
 */
import type { OperationInput } from "../operation-inputs.ts"

const modelSafe = (name: string): string => name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64)

export const modelSafeArgumentNames = (
  inputs: ReadonlyArray<OperationInput>
): ReadonlyArray<OperationInput> =>
  inputs.map((input) => ({ ...input, argument: modelSafe(input.argument) }))
