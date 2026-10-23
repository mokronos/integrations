import { whenPresent, type AuthMethod, type Connection, type IntegrationOverview } from "@integragents/contracts"
import { Check, KeyRound, RotateCw } from "lucide-react"
import { useEffect, useState } from "react"

import { AuthMethodDetails } from "@/components/integrations/auth-method-details"
import { ErrorNotice } from "@/components/error-notice"
import { FieldProblem } from "@/components/field-problem"
import { fieldError } from "@/lib/errors"
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

const needsClientMessage =
  "This provider needs an OAuth application of its own. Fill in the client ID and secret above, then authorize again."

const credentialNames = (method: AuthMethod): ReadonlyArray<string> => [
  ...new Set(
    (method.placements ?? []).flatMap((placement) => (placement.variable === undefined ? [] : [placement.variable]))
  )
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
      <DialogTrigger render={<Button size="sm" />}>Connect</DialogTrigger>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <ConnectFlow integration={integration} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

export const reauthorizationMethod = (
  integration: IntegrationOverview,
  connection: Connection
): AuthMethod | undefined =>
  connection.owner === "org" && connection.status === "reauthorization_required"
    ? integration.authMethods.find((method) => method.kind === "oauth" && method.template === connection.template)
    : undefined

export function ReauthorizeDialog({
  integration,
  connection,
  method
}: {
  readonly integration: IntegrationOverview
  readonly connection: Connection
  readonly method: AuthMethod
}) {
  const [open, setOpen] = useState(false)
  const invalidate = useInvalidate()
  const oauth = useOAuthConnect(integration, connection.name, method)

  useEffect(() => {
    if (oauth.connected) invalidate(keys.integrations, keys.connections)
  }, [oauth.connected, invalidate])

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) oauth.reset()
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true)
          oauth.start()
        }}
      >
        <RotateCw />
        Reauthorize
      </Button>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {oauth.connected ? `${integration.name} reauthorized` : `Reauthorize ${connection.name}`}
          </DialogTitle>
          <DialogDescription>
            {oauth.connected
              ? "The connection has a fresh token and its tools work again."
              : `Sign in to ${integration.name} again to renew this connection's token.`}
          </DialogDescription>
        </DialogHeader>
        {oauth.connected ? (
          <Alert>
            <Check />
            <AlertTitle>Connection ready</AlertTitle>
            <AlertDescription>OAuth authorization completed successfully.</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4">
            {oauth.fields}
            {oauth.failure === undefined ? null : (
              <ErrorNotice title={oauth.failure.title} step={oauth.failure.step} error={oauth.failure.error} />
            )}
          </div>
        )}
        <DialogFooter>
          {oauth.connected ? (
            <Button onClick={() => changeOpen(false)}>Done</Button>
          ) : (
            <Button onClick={oauth.start} disabled={oauth.starting || oauth.waiting}>
              {oauth.waiting
                ? "Waiting for authorization…"
                : oauth.starting
                  ? "Preparing OAuth…"
                  : "Authorize with provider"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConnectFlow({
  integration,
  onDone
}: {
  readonly integration: IntegrationOverview
  readonly onDone: () => void
}) {
  const [name, setName] = useState("default")
  const [template, setTemplate] = useState(integration.authMethods[0]?.template)
  const method = integration.authMethods.find((candidate) => candidate.template === template)
  const connection = name.trim()

  const invalidate = useInvalidate()
  const [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const connect = useMutation({
    mutationFn: (method: AuthMethod) =>
      gateway.createConnection({
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

      {connected ? (
        <Alert>
          <Check />
          <AlertTitle>Connection ready</AlertTitle>
          <AlertDescription>
            {connect.data === undefined
              ? "OAuth authorization completed successfully."
              : `${connect.data.tools.length} ${connect.data.tools.length === 1 ? "tool is" : "tools are"} available through ${connection}.`}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="connect-name">Connection name</Label>
            <Input
              id="connect-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="default"
              disabled={oauth.waiting}
            />
            <p className="text-muted-foreground text-xs">
              Use a distinct name for each account, such as work or personal.
            </p>
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

          {method === undefined ? (
            <ErrorNotice
              title="Authentication unavailable"
              step="Selecting an authentication method"
              error={new Error("This integration has no usable authentication option.")}
            />
          ) : method.kind === "oauth" ? (
            oauth.fields
          ) : (
            <CredentialFields
              method={method}
              values={values}
              onChange={setValues}
              problem={fieldError(connect.error, "values") ?? fieldError(connect.error, "template")}
            />
          )}

          {connect.error === null || fieldError(connect.error, "values") !== undefined ? null : (
            <ErrorNotice
              title="Connection failed"
              step="Saving the credential and verifying the endpoint"
              error={connect.error}
              onRetry={() => {
                if (method !== undefined) connect.mutate(method)
              }}
            />
          )}
          {oauth.failure === undefined ? null : (
            <ErrorNotice title={oauth.failure.title} step={oauth.failure.step} error={oauth.failure.error} />
          )}
        </div>
      )}

      <DialogFooter>
        {connected ? (
          <Button onClick={onDone}>Done</Button>
        ) : method?.kind === "oauth" ? (
          <Button onClick={oauth.start} disabled={oauth.starting || oauth.waiting || connection.length === 0}>
            {oauth.waiting
              ? "Waiting for authorization…"
              : oauth.starting
                ? "Preparing OAuth…"
                : "Authorize with provider"}
          </Button>
        ) : (
          <Button
            onClick={() => {
              if (method !== undefined) connect.mutate(method)
            }}
            disabled={
              connect.isPending || connection.length === 0 || method === undefined || !hasCredential(method, values)
            }
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

function CredentialFields({
  method,
  values,
  onChange,
  problem
}: {
  readonly method: AuthMethod
  readonly values: Readonly<Record<string, string>>
  readonly onChange: (values: Readonly<Record<string, string>>) => void
  readonly problem: string | undefined
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
              aria-invalid={problem !== undefined}
            />
          </div>
        )
      })}
      <FieldProblem problem={problem} />
    </div>
  )
}

type OAuthFailure = { readonly title: string; readonly step: string; readonly error: Error }

function useOAuthConnect(integration: IntegrationOverview, connection: string, method: AuthMethod | undefined) {
  const { data: callbackUrl } = useOAuthCallbackUrl()
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [replaceSavedClient, setReplaceSavedClient] = useState(false)
  const [popupBlocked, setPopupBlocked] = useState(false)
  const savedClientId = integration.savedOAuthClientId
  const enteringClient = savedClientId === undefined || replaceSavedClient

  const start = useMutation({
    mutationFn: (method: AuthMethod) =>
      gateway.startOAuth({
        integration: integration.slug,
        connection,
        template: method.template,
        ...whenPresent("clientId", enteringClient ? clientId.trim() || undefined : undefined),
        ...whenPresent("clientSecret", enteringClient ? clientSecret || undefined : undefined)
      }),
    onSuccess: (started) => {
      if (started.state.status === "needs-client") setReplaceSavedClient(true)
      if (started.state.status !== "pending") return
      // `noopener` would make `window.open` answer null even when the tab opened.
      const opened = window.open(started.state.authorizationUrl, "_blank")
      if (opened !== null) opened.opener = null
      setPopupBlocked(opened === null)
    }
  })
  const session = useOAuthSession(start.data?.state.status === "pending" ? start.data.id : undefined)
  const state = session.data?.state ?? start.data?.state
  const waiting = state?.status === "pending"
  const needsClient = state?.status === "needs-client"

  const failure = ((): OAuthFailure | undefined => {
    if (start.error !== null)
      return { title: "OAuth could not start", step: "Preparing authorization with the gateway", error: start.error }
    const step =
      session.data === undefined
        ? "Preparing authorization with the provider"
        : "Provider authorization and token exchange"
    if (state?.status === "failed")
      return { title: "OAuth authorization has a problem", step, error: state.error ?? new Error(state.message) }
    if (state?.status === "needs-client")
      return { title: "OAuth authorization has a problem", step, error: new Error(needsClientMessage) }
    if (session.error !== null)
      return {
        title: "OAuth authorization has a problem",
        step: "Checking OAuth status with the gateway",
        error: session.error
      }
    if (waiting && popupBlocked) {
      return {
        title: "OAuth authorization has a problem",
        step: "Opening the provider authorization page",
        error: new Error("The browser blocked the new tab. Open the authorization link below to continue.")
      }
    }
    return undefined
  })()

  const fields =
    method === undefined ? null : (
      <div className="space-y-3">
        {method.oauth?.supportsDynamicRegistration === true && !needsClient ? (
          <Alert>
            <Check />
            <AlertTitle>Automatic client registration supported</AlertTitle>
            <AlertDescription>
              The gateway will register itself with the provider before opening authorization.
            </AlertDescription>
          </Alert>
        ) : enteringClient ? (
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
            {savedClientId === undefined ? null : (
              <Button
                variant="link"
                size="sm"
                className="w-fit px-0 sm:col-span-2"
                onClick={() => setReplaceSavedClient(false)}
                disabled={waiting}
              >
                Keep the saved client
              </Button>
            )}
          </div>
        ) : (
          <Alert>
            <KeyRound />
            <AlertTitle>Using saved OAuth client</AlertTitle>
            <AlertDescription className="space-y-1">
              <p className="break-all font-mono text-xs">{savedClientId}</p>
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={() => setReplaceSavedClient(true)}
                disabled={waiting}
              >
                Use a different client
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {state?.status === "pending" ? (
          <AwaitingAuthorization
            description="Complete the provider page. The dashboard is checking the gateway for the result."
            authorizationUrl={state.authorizationUrl}
          />
        ) : null}
      </div>
    )

  return {
    fields,
    failure,
    waiting,
    connected: state?.status === "connected",
    starting: start.isPending,
    start: () => {
      if (method !== undefined) start.mutate(method)
    },
    reset: () => {
      start.reset()
      setPopupBlocked(false)
    }
  }
}
