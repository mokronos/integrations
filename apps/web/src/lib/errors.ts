import { describeError, isGatewayError, presentError } from "@integragents/contracts"
import type { ErrorPresentation } from "@integragents/contracts"
import { toast } from "sonner"

/** How the dashboard shows a failed call: the gateway's own explanation, or the browser's when it never answered. */
export const presentationOf = (error: Error): ErrorPresentation | undefined =>
  isGatewayError(error) ? presentError(error) : undefined

/** The problem with one input of a form, when the gateway named it. */
export const fieldError = (error: Error | null, field: string): string | undefined => {
  if (error === null || !isGatewayError(error) || error._tag !== "InvalidInput") return undefined
  const issue = (error.issues ?? []).find(
    (candidate) => candidate.path === field || candidate.path.startsWith(`${field}.`)
  )
  if (issue !== undefined) return issue.message
  return error.field === field ? error.problem : undefined
}

/** Text a person can hand to their agent, so it can work out what to change. */
export const agentPrompt = (error: Error, attempted: string): string =>
  [
    `The integrations gateway dashboard failed to ${attempted.toLowerCase()}.`,
    "",
    isGatewayError(error) ? describeError(error) : error.message,
    "",
    "What should I change to fix this?"
  ].join("\n")

export const toastError = (title: string, error: Error): void => {
  const presentation = presentationOf(error)
  toast.error(title, {
    description: presentation?.hint === undefined ? error.message : `${error.message}. ${presentation.hint}`,
    action: {
      label: "Copy for agent",
      onClick: () => void navigator.clipboard.writeText(agentPrompt(error, title))
    }
  })
}
