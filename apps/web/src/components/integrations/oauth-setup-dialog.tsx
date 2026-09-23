import { whenPresent } from "@mokronos/integrations-contracts"
import { Check } from "lucide-react"
import { useEffect, useState } from "react"
import { useSearchParams } from "react-router"

import { OperationError } from "@/components/integrations/operation-feedback"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import * as gateway from "@/lib/gateway"
import { keys, useIntegrations, useInvalidate, useMutation, useOAuthCallbackUrl, useOAuthSession } from "@/lib/queries"
import { AwaitingAuthorization, OAuthClientFields } from "./oauth-flow"
import { OAuthSetupPanel } from "./oauth-setup-panel"

/**
 * An agent cannot be handed an OAuth client secret, so `i connect` parks the
 * session and sends a human here with `?setup=<session>`.
 */
export function OAuthSetupDialog() {
  const [params, setParams] = useSearchParams()
  const sessionId = params.get("setup") ?? undefined
  const invalidate = useInvalidate()
  const { data: callbackUrl } = useOAuthCallbackUrl()
  const { data: integrations } = useIntegrations()
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const session = useOAuthSession(sessionId)

  const integration = integrations?.find((candidate) => candidate.slug === session.data?.integration)
  const method = integration?.authMethods.find((candidate) => candidate.kind === "oauth")

  const submit = useMutation({
    mutationFn: (id: string) =>
      gateway.provideOAuthClient(id, {
        clientId: clientId.trim(),
        ...whenPresent("clientSecret", clientSecret.length === 0 ? undefined : clientSecret)
      }),
    onSuccess: (resumed) => {
      setClientSecret("")
      invalidate(keys.oauthSession(resumed.id))
      if (resumed.state.status === "pending") window.open(resumed.state.authorizationUrl, "_blank", "noopener")
    }
  })
  const state = session.data?.state ?? submit.data?.state

  useEffect(() => {
    if (state?.status === "connected") invalidate(keys.integrations, keys.connections)
  }, [state?.status, invalidate])

  const close = () => {
    const next = new URLSearchParams(params)
    next.delete("setup")
    setParams(next, { replace: true })
    setClientId("")
    setClientSecret("")
    submit.reset()
  }

  if (sessionId === undefined) return null

  return (
    <Dialog open onOpenChange={(next) => next ? undefined : close()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Register an OAuth application{integration === undefined ? "" : ` for ${integration.name}`}
          </DialogTitle>
          <DialogDescription>
            An agent asked to connect this integration and stopped here. The
            provider needs an OAuth application that only you can create, so the
            client secret is typed here and goes straight to the gateway.
          </DialogDescription>
        </DialogHeader>

        {session.error !== null
          ? (
            <OperationError
              title="That setup link is not usable"
              step="Reading the OAuth session"
              error={session.error}
            />
          )
          : state === undefined
          ? <p className="text-muted-foreground text-sm">Loading the pending connection…</p>
          : state.status === "connected"
          ? (
            <Alert>
              <Check />
              <AlertTitle>Connected</AlertTitle>
              <AlertDescription>
                {integration?.name ?? session.data?.integration} is authorized. The
                waiting agent has been told.
              </AlertDescription>
            </Alert>
          )
          : state.status === "failed"
          ? (
            <OperationError
              title="Authorization failed"
              step="Provider authorization and token exchange"
              error={new Error(state.message)}
            />
          )
          : state.status === "pending"
          ? <AwaitingAuthorization description="The application was saved. Finish the provider's consent page." authorizationUrl={state.authorizationUrl} />
          : (
            <div className="space-y-4">
              {method === undefined
                ? null
                : <OAuthSetupPanel method={method} callbackUrl={callbackUrl} />}
              <OAuthClientFields
                idPrefix="setup"
                clientId={clientId}
                clientSecret={clientSecret}
                onClientIdChange={setClientId}
                onClientSecretChange={setClientSecret}
              />
              {submit.error === null ? null : (
                <OperationError
                  title="The provider rejected that application"
                  step="Saving the OAuth client and starting authorization"
                  error={submit.error}
                />
              )}
            </div>
          )}

        <DialogFooter>
          {state?.status === "needs-client"
            ? (
              <Button
                onClick={() => submit.mutate(sessionId)}
                disabled={submit.isPending || clientId.trim().length === 0}
              >
                {submit.isPending ? "Saving…" : "Save and authorize"}
              </Button>
            )
            : <Button onClick={close}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
