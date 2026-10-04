/**
 * Some documents declare the credential a security scheme carries as an
 * ordinary parameter too. The gateway injects credentials itself, so the agent
 * is never asked for one.
 */
import { Option } from "effect"
import type { OperationInput } from "../operation-inputs.ts"
import type { AdaptationContext } from "./context.ts"

const carriedBy = (context: AdaptationContext): ReadonlySet<string> =>
  new Set(context.securitySchemes.flatMap((scheme) => {
    if (scheme.type !== "apiKey") return ["header:authorization"]
    return Option.match(Option.all([scheme.in, scheme.headerName]), {
      onNone: () => [],
      onSome: ([location, name]) => [`${location}:${name.toLowerCase()}`]
    })
  }))

export const dropCredentialParameters = (
  inputs: ReadonlyArray<OperationInput>,
  context: AdaptationContext
): ReadonlyArray<OperationInput> => {
  const carried = carriedBy(context)
  return inputs.filter((input) =>
    input.kind === "body" ||
    !carried.has(`${input.parameter.location}:${input.parameter.name.toLowerCase()}`)
  )
}
