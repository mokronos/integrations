import { whenPresent } from "@integrations/contracts"
import { useQuery } from "@tanstack/react-query"
import { Check, ExternalLink, LoaderCircle } from "lucide-react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import * as gateway from "@/lib/gateway"
import { keys, useIntegrations, useInvalidate, useMutation, useOAuthCallbackUrl } from "@/lib/queries"
import { OAuthSetupPanel } from "./oauth-setup-panel"

/**
 * An agent cannot be handed an OAuth client secret, so `i connect` parks the
 * session and sends a human here with `?setup=<session>`.
 */
export function OAuthSetupDialog() {
  const [params, setParams] = useSearchParams()
  const sessionId = params.get("setup")
  const invalidate = useInvalidate()
  const { data: callbackUrl } = useOAuthCallbackUrl()
  const { data: integrations } = useIntegrations()
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [authorizationUrl, setAuthorizationUrl] = useState<string | undefined>()

  const session = useQuery({
    queryKey: keys.oauthSession(sessionId ?? ""),
    queryFn: () => gateway.pollOAuth(sessionId ?? ""),
    enabled: sessionId !== null,
    refetchInterval: (query) =>
      query.state.data?.state.status === "pending" ? 1_500 : false
  })

  const state = session.data?.state
  const integration = integrations?.find((candidate) => candidate.slug === session.data?.integration)
  const method = integration?.authMethods.find((candidate) => candidate.kind === "oauth")

  const submit = useMutation({
    mutationFn: () =>
      gateway.provideOAuthClient(sessionId ?? "", {
        clientId: clientId.trim(),
        ...whenPresent("clientSecret", clientSecret.length === 0 ? undefined : clientSecret)
      }),
    onSuccess: (resumed) => {
      setClientSecret("")
      invalidate(keys.oauthSession(sessionId ?? ""), keys.integrations, keys.connections)
      if (resumed.state.status === "pending") {
        setAuthorizationUrl(resumed.state.authorizationUrl)
        window.open(resumed.state.authorizationUrl, "_blank", "noopener")
      }
    }
  })

  useEffect(() => {
    if (state?.status === "connected") invalidate(keys.integrations, keys.connections)
  }, [state?.status, invalidate])

  const close = () => {
    const next = new URLSearchParams(params)
    next.delete("setup")
    setParams(next, { replace: true })
    setClientId("")
    setClientSecret("")
    setAuthorizationUrl(undefined)
    submit.reset()
  }

  if (sessionId === null) return null

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
          ? (
            <Alert>
              <LoaderCircle className="animate-spin" />
              <AlertTitle>Waiting for provider authorization</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>The application was saved. Finish the provider's consent page.</p>
                {(authorizationUrl ?? state.authorizationUrl) === undefined ? null : (
                  <a
                    className="inline-flex items-center gap-1 font-medium"
                    href={authorizationUrl ?? state.authorizationUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open authorization page <ExternalLink className="size-3" />
                  </a>
                )}
              </AlertDescription>
            </Alert>
          )
          : (
            <div className="space-y-4">
              {method === undefined
                ? null
                : <OAuthSetupPanel method={method} callbackUrl={callbackUrl} />}
              <div className="space-y-1.5">
                <Label htmlFor="setup-client-id">OAuth client ID</Label>
                <Input
                  id="setup-client-id"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  placeholder="From the provider console"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setup-client-secret">Client secret</Label>
                <Input
                  id="setup-client-secret"
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  placeholder="Leave empty if the provider issues none"
                />
              </div>
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
                onClick={() => submit.mutate()}
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
