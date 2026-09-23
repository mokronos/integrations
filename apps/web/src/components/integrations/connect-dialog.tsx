import { whenPresent, type AuthMethod, type IntegrationOverview } from "@mokronos/integrations-contracts"
import { Check } from "lucide-react"
import { useEffect, useState } from "react"

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
import { keys, useInvalidate, useMutation, useOAuthCallbackUrl, useOAuthSession } from "@/lib/queries"
import { AwaitingAuthorization, OAuthClientFields } from "./oauth-flow"
import { OAuthSetupPanel } from "./oauth-setup-panel"

const needsClientMessage = "This provider needs an OAuth application of its own. Fill in the client ID and secret above, then authorize again."

const credentialNames = (method: AuthMethod): ReadonlyArray<string> => [
  ...new Set((method.placements ?? []).flatMap((placement) => placement.variable === undefined ? [] : [placement.variable]))
]

const credentialLabel = (method: AuthMethod): string => {
  const placement = method.placements?.[0]
  if (method.kind === "apikey") return placement?.name ?? "API key"
  if (placement?.prefix.trim().toLowerCase() === "basic") return "Basic credential"
  if (placement?.prefix.trim().toLowerCase() === "bearer") return "Bearer token"
  return "Credential"
}

export function ConnectDialog({ integration }: { readonly integration: IntegrationOverview }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        Connect
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <ConnectFlow integration={integration} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

function ConnectFlow({ integration, onDone }: { readonly integration: IntegrationOverview; readonly onDone: () => void }) {
  const [name, setName] = useState("default")
  const [template, setTemplate] = useState(integration.authMethods[0]?.template)
  const method = integration.authMethods.find((candidate) => candidate.template === template)
  const connection = name.trim()

  const invalidate = useInvalidate()
  const [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const connect = useMutation({
    mutationFn: (method: AuthMethod) => gateway.createConnection({
      integration: integration.slug,
      connection,
      template: method.template,
      ...whenPresent("values", method.kind === "none" ? undefined : values)
    })
  })

  const oauth = useOAuthConnect(integration, connection, method)
  const connected = connect.data !== undefined || oauth.connected

  useEffect(() => {
    if (connected) invalidate(keys.integrations, keys.connections)
  }, [connected, invalidate])

  const selectMethod = (next: string) => {
    setTemplate(next)
    setValues({})
    connect.reset()
    oauth.reset()
  }

  return (
    <>
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
                : `${connect.data.tools.length} ${connect.data.tools.length === 1 ? "tool is" : "tools are"} available through ${connection}.`}
            </AlertDescription>
          </Alert>
        )
        : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="connect-name">Connection name</Label>
              <Input id="connect-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="default" disabled={oauth.waiting} />
              <p className="text-muted-foreground text-xs">Use a distinct name for each account, such as work or personal.</p>
            </div>

            <div className="space-y-2" role="radiogroup" aria-label="Authentication method">
              <Label>Authentication method</Label>
              {integration.authMethods.map((candidate) => (
                <AuthMethodDetails
                  key={candidate.id}
                  method={candidate}
                  selected={candidate.template === template}
                  onSelect={oauth.waiting ? undefined : selectMethod}
                />
              ))}
            </div>

            {method === undefined
              ? <OperationError title="Authentication unavailable" step="Selecting an authentication method" error={new Error("This integration has no usable authentication option.")} />
              : method.kind === "oauth"
                ? oauth.fields
                : <CredentialFields method={method} values={values} onChange={setValues} />}

            {connect.error === null ? null : (
              <OperationError title="Connection failed" step="Saving the credential and verifying the endpoint" error={connect.error} />
            )}
            {oauth.failure === undefined ? null : (
              <OperationError title={oauth.failure.title} step={oauth.failure.step} error={oauth.failure.error} />
            )}
          </div>
        )}

      <DialogFooter>
        {connected
          ? <Button onClick={onDone}>Done</Button>
          : method?.kind === "oauth"
            ? (
              <Button onClick={oauth.start} disabled={oauth.starting || oauth.waiting || connection.length === 0}>
                {oauth.waiting ? "Waiting for authorization…" : oauth.starting ? "Preparing OAuth…" : "Authorize with provider"}
              </Button>
            )
            : (
              <Button
                onClick={() => { if (method !== undefined) connect.mutate(method) }}
                disabled={connect.isPending || connection.length === 0 || method === undefined || !hasCredential(method, values)}
              >
                {connect.isPending ? "Saving and verifying…" : "Connect and verify"}
              </Button>
            )}
      </DialogFooter>
    </>
  )
}

const credentialKeys = (method: AuthMethod): ReadonlyArray<string> => {
  const names = credentialNames(method)
  return names.length === 0 ? ["token"] : names
}

const hasCredential = (method: AuthMethod, values: Readonly<Record<string, string>>): boolean =>
  method.kind === "none" || credentialKeys(method).every((key) => (values[key] ?? "").trim().length > 0)

function CredentialFields({ method, values, onChange }: {
  readonly method: AuthMethod
  readonly values: Readonly<Record<string, string>>
  readonly onChange: (values: Readonly<Record<string, string>>) => void
}) {
  if (method.kind === "none") {
    return (
      <Alert>
        <Check />
        <AlertTitle>No credential required</AlertTitle>
        <AlertDescription>The gateway will verify the endpoint and create an addressable connection.</AlertDescription>
      </Alert>
    )
  }
  const named = credentialNames(method).length > 0
  return (
    <div className="space-y-3 rounded-lg border p-3">
      {credentialKeys(method).map((key) => {
        const label = named ? key : credentialLabel(method)
        return (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={`credential-${key}`}>{label}</Label>
            <Input
              id={`credential-${key}`}
              type="password"
              value={values[key] ?? ""}
              onChange={(event) => onChange({ ...values, [key]: event.target.value })}
              placeholder={`Paste ${named ? key : label.toLowerCase()}`}
            />
          </div>
        )
      })}
    </div>
  )
}

type OAuthFailure = { readonly title: string; readonly step: string; readonly error: Error }

function useOAuthConnect(integration: IntegrationOverview, connection: string, method: AuthMethod | undefined) {
  const { data: callbackUrl } = useOAuthCallbackUrl()
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [popupBlocked, setPopupBlocked] = useState(false)

  const start = useMutation({
    mutationFn: (method: AuthMethod) => gateway.startOAuth({
      integration: integration.slug,
      connection,
      template: method.template,
      ...whenPresent("clientId", clientId.trim() || undefined),
      ...whenPresent("clientSecret", clientSecret || undefined)
    }),
    onSuccess: (started) => {
      if (started.state.status !== "pending") return
      setPopupBlocked(window.open(started.state.authorizationUrl, "_blank", "noopener") === null)
    }
  })
  const session = useOAuthSession(start.data?.state.status === "pending" ? start.data.id : undefined)
  const state = session.data?.state ?? start.data?.state
  const waiting = state?.status === "pending"

  const failure = ((): OAuthFailure | undefined => {
    if (start.error !== null) return { title: "OAuth could not start", step: "Preparing authorization with the gateway", error: start.error }
    const step = session.data === undefined ? "Preparing authorization with the provider" : "Provider authorization and token exchange"
    if (state?.status === "failed") return { title: "OAuth authorization has a problem", step, error: new Error(state.message) }
    if (state?.status === "needs-client") return { title: "OAuth authorization has a problem", step, error: new Error(needsClientMessage) }
    if (session.error !== null) return { title: "OAuth authorization has a problem", step: "Checking OAuth status with the gateway", error: session.error }
    if (waiting && popupBlocked) {
      return {
        title: "OAuth authorization has a problem",
        step: "Opening the provider authorization page",
        error: new Error("The browser blocked the new tab. Open the authorization link below to continue.")
      }
    }
    return undefined
  })()

  const fields = method === undefined ? null : (
    <div className="space-y-3">
      {method.oauth?.supportsDynamicRegistration === true
        ? (
          <Alert>
            <Check />
            <AlertTitle>Automatic client registration supported</AlertTitle>
            <AlertDescription>The gateway will register itself with the provider before opening authorization.</AlertDescription>
          </Alert>
        )
        : (
          <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
            <OAuthSetupPanel method={method} callbackUrl={callbackUrl} />
            <OAuthClientFields
              idPrefix="oauth"
              clientId={clientId}
              clientSecret={clientSecret}
              onClientIdChange={setClientId}
              onClientSecretChange={setClientSecret}
              disabled={waiting}
            />
          </div>
        )}
      {state?.status === "pending"
        ? <AwaitingAuthorization description="Complete the provider page. The dashboard is checking the gateway for the result." authorizationUrl={state.authorizationUrl} />
        : null}
    </div>
  )

  return {
    fields,
    failure,
    waiting,
    connected: state?.status === "connected",
    starting: start.isPending,
    start: () => { if (method !== undefined) start.mutate(method) },
    reset: () => {
      start.reset()
      setPopupBlocked(false)
    }
  }
}
