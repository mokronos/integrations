import { ExternalLink, LoaderCircle } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function OAuthClientFields({ idPrefix, clientId, clientSecret, onClientIdChange, onClientSecretChange, disabled = false }: {
  readonly idPrefix: string
  readonly clientId: string
  readonly clientSecret: string
  readonly onClientIdChange: (value: string) => void
  readonly onClientSecretChange: (value: string) => void
  readonly disabled?: boolean
}) {
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-client-id`}>OAuth client ID</Label>
        <Input
          id={`${idPrefix}-client-id`}
          value={clientId}
          onChange={(event) => onClientIdChange(event.target.value)}
          placeholder="From the provider console"
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-client-secret`}>Client secret</Label>
        <Input
          id={`${idPrefix}-client-secret`}
          type="password"
          value={clientSecret}
          onChange={(event) => onClientSecretChange(event.target.value)}
          placeholder="Leave empty if the provider issues none"
          disabled={disabled}
        />
      </div>
    </>
  )
}

export function AwaitingAuthorization({ description, authorizationUrl }: {
  readonly description: string
  readonly authorizationUrl: string | undefined
}) {
  return (
    <Alert>
      <LoaderCircle className="animate-spin" />
      <AlertTitle>Waiting for provider authorization</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{description}</p>
        {authorizationUrl === undefined ? null : (
          <a className="inline-flex items-center gap-1 font-medium" href={authorizationUrl} target="_blank" rel="noreferrer">
            Open authorization page <ExternalLink className="size-3" />
          </a>
        )}
      </AlertDescription>
    </Alert>
  )
}
