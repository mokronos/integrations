import { AlertCircle, RotateCw } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { agentPrompt, presentationOf } from "@/lib/errors"

/** A failed step, with what to do next, how to retry when that can help, and its details for an agent or operator. */
export function ErrorNotice({
  title,
  step,
  error,
  onRetry
}: {
  readonly title: string
  readonly step?: string
  readonly error: Error
  readonly onRetry?: () => void
}) {
  const presentation = presentationOf(error)
  const issues = presentation === undefined || presentation.issues.length < 2 ? [] : presentation.issues
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-1">
        {step === undefined ? null : (
          <p>
            <span className="font-medium">Stopped at:</span> {step}
          </p>
        )}
        <p>{error.message}</p>
        {issues.length === 0 ? null : (
          <ul className="list-disc pl-4">
            {issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                <span className="font-mono">{issue.path}</span>: {issue.message}
              </li>
            ))}
          </ul>
        )}
        {presentation?.hint === undefined || issues.length > 0 ? null : (
          <p>
            <span className="font-medium">Next:</span> {presentation.hint}
          </p>
        )}
        {presentation === undefined ? null : (
          <dl className="mt-2 grid gap-x-3 gap-y-0.5 font-mono text-xs sm:grid-cols-[auto_1fr]">
            <dt>Code</dt>
            <dd>
              {presentation.code} (HTTP {presentation.status})
            </dd>
            {presentation.traceId === undefined ? null : (
              <>
                <dt>Trace ID</dt>
                <dd className="break-all">{presentation.traceId}</dd>
              </>
            )}
          </dl>
        )}
        <div className="flex items-center gap-1 pt-1">
          {onRetry === undefined || presentation?.retryable !== true ? null : (
            <Button variant="outline" size="xs" onClick={onRetry}>
              <RotateCw />
              Retry
            </Button>
          )}
          <span className="text-muted-foreground text-xs">Copy for agent</span>
          <CopyButton value={agentPrompt(error, title)} label="Error report" />
        </div>
      </AlertDescription>
    </Alert>
  )
}
