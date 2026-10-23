import { InvalidInput } from "@integragents/contracts"
import type { InvocationInvalid, Json } from "@integragents/contracts"
import { jsonSchemaIssues } from "@integragents/integrations"

/**
 * Check a call's arguments against the tool's declared input schema. A tool
 * without a usable object schema is not checked; the vendor decides then.
 */
export const invalidArguments = (
  inputSchema: Json | undefined,
  value: Json,
  tool: string
): InvocationInvalid | undefined => {
  const issues = jsonSchemaIssues(inputSchema, value)
  if (issues === undefined) return undefined
  const headline = issues[0]
  return {
    status: "invalid",
    error: new InvalidInput({
      field: "arguments",
      problem:
        headline === undefined
          ? `they do not match what ${tool} accepts`
          : `${tool} rejects them: ${headline.path}: ${headline.message}`,
      issues
    })
  }
}
