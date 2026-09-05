import { whenPresent } from "@mokronos/contracts"
import { Check, ExternalLink, LoaderCircle } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { AuthMethodDetails } from "@/components/integrations/auth-method-details"
import { OperationError } from "@/components/integrations/operation-feedback"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import * as gateway from "@/lib/gateway"
import { keys, useInvalidate, useMutation, useOAuthCallbackUrl } from "@/lib/queries"
import type { AuthMethod, IntegrationOverview } from "@/lib/schemas"
import { OAuthSetupPanel } from "./oauth-setup-panel"

type OAuthFailure = {
  readonly source: "popup" | "poll" | "provider"
  readonly step: string
  readonly error: Error
}

const credentialNames = (method: AuthMethod | undefined): ReadonlyArray<string> => [
  ...new Set(
    (method?.placements ?? []).flatMap((placement) =>
      placement.variable === undefined ? [] : [placement.variable]
    )
  )
]

const credentialLabel = (method: AuthMethod | undefined): string => {
  const placement = method?.placements?.[0]
  if (method?.kind === "apikey") return placement?.name ?? "API key"
  if (placement?.prefix.trim().toLowerCase() === "basic") return "Basic credential"
  if (placement?.prefix.trim().toLowerCase() === "bearer") return "Bearer token"
  return "Credential"
}

export function ConnectDialog({ integration }: { readonly integration: IntegrationOverview }) {
  const invalidate = useInvalidate()
  const { data: callbackUrl } = useOAuthCallbackUrl()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("default")
  const [template, setTemplate] = useState(integration.authMethods[0]?.template ?? "")
  const [token, setToken] = useState("")
  const [credentialValues, setCredentialValues] = useState<Readonly<Record<string, string>>>({})
  const [oauthClientId, setOAuthClientId] = useState("")
  const [oauthClientSecret, setOAuthClientSecret] = useState("")
  const [session, setSession] = useState<string | undefined>()
  const [authorizationUrl, setAuthorizationUrl] = useState<string | undefined>()
  const [oauthFailure, setOAuthFailure] = useState<OAuthFailure | undefined>()
  const [oauthConnected, setOAuthConnected] = useState(false)

  const method = integration.authMethods.find((candidate) => candidate.template === template)
  const variables = useMemo(() => credentialNames(method), [method])
  const isOAuth = method?.kind === "oauth"
  const isNoAuth = method?.kind === "none"
  const needsOAuthClient = isOAuth && method.oauth?.supportsDynamicRegistration !== true
  const hasCredential = variables.length === 0
    ? token.trim().length > 0
    : variables.every((variable) => (credentialValues[variable] ?? "").trim().length > 0)
  const canConnect = name.trim().length > 0 && method !== undefined && (isNoAuth || hasCredential)

  const connect = useMutation({
    mutationFn: () => {
      const values = variables.length === 0
        ? token.length === 0 ? undefined : { token }
        : credentialValues
      return gateway.createConnection({
        integration: integration.slug,
        connection: name.trim(),
        ...whenPresent("template", template || undefined),
        ...whenPresent("values", values)
      })
    },
    onSuccess: () => {
      invalidate(keys.integrations, keys.connections)
      setToken("")
      setCredentialValues({})
    }
  })

  const startOAuth = useMutation({
    mutationFn: () => gateway.startOAuth({
      integration: integration.slug,
      connection: name.trim(),
      ...whenPresent("template", template || undefined),
      ...whenPresent("clientId", oauthClientId.trim() || undefined),
      ...whenPresent("clientSecret", oauthClientSecret || undefined)
    }),
    onSuccess: (started) => {
      setOAuthFailure(undefined)
      if (started.state.status === "connected") {
        setOAuthConnected(true)
        invalidate(keys.integrations, keys.connections)
        return
      }
      if (started.state.status === "failed") {
        setOAuthFailure({
          source: "provider",
          step: "Preparing authorization with the provider",
          error: new Error(started.state.message)
        })
        return
      }
      setSession(started.id)
      setAuthorizationUrl(started.state.authorizationUrl)
      const providerTab = window.open(started.state.authorizationUrl, "_blank", "noopener")
      if (providerTab === null) {
        setOAuthFailure({
          source: "popup",
          step: "Opening the provider authorization page",
          error: new Error("The browser blocked the new tab. Open the authorization link below to continue.")
        })
      }
    }
  })

  useEffect(() => {
    if (session === undefined) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        const current = await gateway.pollOAuth(session)
        if (cancelled) return
        if (current.state.status === "connected") {
          setSession(undefined)
          setAuthorizationUrl(undefined)
          setOAuthFailure(undefined)
          setOAuthConnected(true)
          invalidate(keys.integrations, keys.connections)
          return
        }
        if (current.state.status === "failed") {
          setSession(undefined)
          setAuthorizationUrl(undefined)
          setOAuthFailure({
            source: "provider",
            step: "Provider authorization and token exchange",
            error: new Error(current.state.message)
          })
          return
        }
        setOAuthFailure((failure) => failure?.source === "poll" ? undefined : failure)
      } catch (cause) {
        if (cancelled) return
        setOAuthFailure({
          source: "poll",
          step: "Checking OAuth status with the gateway",
          error: cause instanceof Error ? cause : new Error("OAuth status could not be checked.")
        })
      }
      timer = setTimeout(() => void poll(), 1_500)
    }

    timer = setTimeout(() => void poll(), 1_500)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [session, integration.slug, invalidate])

  const reset = () => {
    connect.reset()
    startOAuth.reset()
    setName("default")
    setTemplate(integration.authMethods[0]?.template ?? "")
    setToken("")
    setCredentialValues({})
    setOAuthClientId("")
    setOAuthClientSecret("")
    setSession(undefined)
    setAuthorizationUrl(undefined)
    setOAuthFailure(undefined)
    setOAuthConnected(false)
  }

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) reset()
  }

  const selectMethod = (nextTemplate: string) => {
    setTemplate(nextTemplate)
    setToken("")
    setCredentialValues({})
    setOAuthFailure(undefined)
    connect.reset()
    startOAuth.reset()
  }

  const connected = connect.data !== undefined || oauthConnected
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Connect</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{connected ? `${integration.name} connected` : `Connect ${integration.name}`}</DialogTitle>
          <DialogDescription>
            {connected
              ? "The gateway verified the connection and stored its credential securely."
              : "Choose one of the authentication options discovered from this endpoint."}
          </DialogDescription>
        </DialogHeader>

        {connected
          ? (
            <Alert>
              <Check />
              <AlertTitle>Connection ready</AlertTitle>
              <AlertDescription>
                {connect.data === undefined
                  ? "OAuth authorization completed successfully."
                  : `${connect.data.tools.length} ${connect.data.tools.length === 1 ? "tool is" : "tools are"} available through ${name.trim()}.`}
              </AlertDescription>
            </Alert>
          )
          : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="connect-name">Connection name</Label>
                <Input id="connect-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="default" disabled={session !== undefined} />
                <p className="text-muted-foreground text-xs">Use a distinct name for each account, such as work or personal.</p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Authentication method">
                <Label>Authentication method</Label>
                {integration.authMethods.map((candidate) => (
                  <AuthMethodDetails
                    key={candidate.id}
                    method={candidate}
                    selected={candidate.template === template}
                    onSelect={session === undefined ? selectMethod : undefined}
                  />
                ))}
              </div>

              {method === undefined
                ? <OperationError title="Authentication unavailable" step="Selecting an authentication method" error={new Error("This integration has no usable authentication option.")} />
                : isOAuth
                  ? (
                    <div className="space-y-3">
                      {needsOAuthClient ? (
                        <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
                          <OAuthSetupPanel method={method} callbackUrl={callbackUrl} />
                          <div className="space-y-1.5">
                            <Label htmlFor="oauth-client-id">OAuth client ID</Label>
                            <Input id="oauth-client-id" value={oauthClientId} onChange={(event) => setOAuthClientId(event.target.value)} placeholder="From the provider console" disabled={session !== undefined} />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="oauth-client-secret">Client secret</Label>
                            <Input id="oauth-client-secret" type="password" value={oauthClientSecret} onChange={(event) => setOAuthClientSecret(event.target.value)} disabled={session !== undefined} />
                          </div>
                        </div>
                      ) : (
                        <Alert>
                          <Check />
                          <AlertTitle>Automatic client registration supported</AlertTitle>
                          <AlertDescription>The gateway will register itself with the provider before opening authorization.</AlertDescription>
                        </Alert>
                      )}

                      {session === undefined ? null : (
                        <Alert>
                          <LoaderCircle className="animate-spin" />
                          <AlertTitle>Waiting for provider authorization</AlertTitle>
                          <AlertDescription className="space-y-2">
                            <p>Complete the provider page. The dashboard is checking the gateway for the result.</p>
                            {authorizationUrl === undefined ? null : (
                              <a className="inline-flex items-center gap-1 font-medium" href={authorizationUrl} target="_blank" rel="noreferrer">
                                Open authorization page <ExternalLink className="size-3" />
                              </a>
                            )}
                          </AlertDescription>
                        </Alert>
                      )}
                    </div>
                  )
                  : isNoAuth
                    ? (
                      <Alert>
                        <Check />
                        <AlertTitle>No credential required</AlertTitle>
                        <AlertDescription>The gateway will verify the endpoint and create an addressable connection.</AlertDescription>
                      </Alert>
                    )
                    : variables.length > 0
                      ? (
                        <div className="space-y-3 rounded-lg border p-3">
                          {variables.map((variable) => (
                            <div key={variable} className="space-y-1.5">
                              <Label htmlFor={`credential-${variable}`}>{variable}</Label>
                              <Input
                                id={`credential-${variable}`}
                                type="password"
                                value={credentialValues[variable] ?? ""}
                                onChange={(event) => setCredentialValues({ ...credentialValues, [variable]: event.target.value })}
                                placeholder={`Paste ${variable}`}
                              />
                            </div>
                          ))}
                        </div>
                      )
                      : (
                        <div className="space-y-1.5 rounded-lg border p-3">
                          <Label htmlFor="connect-token">{credentialLabel(method)}</Label>
                          <Input id="connect-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={`Paste ${credentialLabel(method).toLowerCase()}`} />
                        </div>
                      )}

              {connect.error === null ? null : (
                <OperationError title="Connection failed" step="Saving the credential and verifying the endpoint" error={connect.error} />
              )}
              {startOAuth.error === null ? null : (
                <OperationError title="OAuth could not start" step="Preparing authorization with the gateway" error={startOAuth.error} />
              )}
              {oauthFailure === undefined ? null : (
                <OperationError title="OAuth authorization has a problem" step={oauthFailure.step} error={oauthFailure.error} />
              )}
            </div>
          )}

        <DialogFooter>
          {connected
            ? <Button onClick={() => changeOpen(false)}>Done</Button>
            : isOAuth
              ? (
                <Button
                  onClick={() => startOAuth.mutate()}
                  disabled={startOAuth.isPending || session !== undefined || name.trim().length === 0 || method === undefined}
                >
                  {session !== undefined
                    ? "Waiting for authorization…"
                    : startOAuth.isPending ? "Preparing OAuth…" : "Authorize with provider"}
                </Button>
              )
              : (
                <Button onClick={() => connect.mutate()} disabled={connect.isPending || !canConnect}>
                  {connect.isPending ? "Saving and verifying…" : "Connect and verify"}
                </Button>
              )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
