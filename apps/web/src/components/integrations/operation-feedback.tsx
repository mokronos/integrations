import { AlertCircle } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { GatewayError } from "@/lib/gateway"

export function OperationError({
  title,
  step,
  error
}: {
  readonly title: string
  readonly step: string
  readonly error: Error
}) {
  const gatewayError = error instanceof GatewayError ? error : undefined
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-1">
        <p><span className="font-medium">Stopped at:</span> {step}</p>
        <p>{error.message}</p>
        {gatewayError === undefined ? null : (
          <dl className="mt-2 grid gap-x-3 gap-y-0.5 font-mono text-xs sm:grid-cols-[auto_1fr]">
            <dt>Request</dt>
            <dd className="break-all">{gatewayError.method} {gatewayError.path}</dd>
            {gatewayError.status === undefined ? null : (
              <><dt>Status</dt><dd>{gatewayError.status}</dd></>
            )}
            {gatewayError.requestId === undefined ? null : (
              <><dt>Request ID</dt><dd className="break-all">{gatewayError.requestId}</dd></>
            )}
          </dl>
        )}
      </AlertDescription>
    </Alert>
  )
}
