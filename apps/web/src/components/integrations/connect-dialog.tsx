import { whenPresent } from "@mokronos/contracts"
import { useEffect, useState } from "react"
import { toast } from "sonner"

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import * as gateway from "@/lib/gateway"
import { keys, useInvalidate, useMutation, useOAuthCallbackUrl } from "@/lib/queries"
import {
  type IntegrationOverview
} from "@/lib/schemas"
import { OAuthSetupPanel } from "./oauth-setup-panel"
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

  const method = integration.authMethods.find((candidate) => candidate.template === template)
  const isOAuth = method?.kind === "oauth"
  const credentialVariables = [...new Set(
    (method?.placements ?? []).flatMap((placement) =>
      placement.variable === undefined ? [] : [placement.variable]
    )
  )]

  const connect = useMutation({
    mutationFn: () => {
      const values = credentialVariables.length === 0
        ? token.length === 0 ? undefined : { token }
        : credentialVariables.some((variable) => (credentialValues[variable] ?? "").length > 0)
          ? credentialValues
          : undefined
      return gateway.createConnection({
        integration: integration.slug,
        connection: name,
        ...whenPresent("template", template || undefined),
        ...whenPresent("values", values)
      })
    },
    onSuccess: (result) => {
      invalidate(keys.integrations, keys.connections)
      toast.success(`Connected ${integration.name}`, {
        description: `${result.tools.length} tools available`
      })
      setOpen(false)
      setToken("")
      setCredentialValues({})
    },
    onError: (error: Error) => toast.error("Could not connect", { description: error.message })
  })

  const startOAuth = useMutation({
    mutationFn: () =>
      gateway.startOAuth({
        integration: integration.slug,
        connection: name,
        ...whenPresent("template", template || undefined),
        ...whenPresent("clientId", oauthClientId.trim() || undefined),
        ...whenPresent("clientSecret", oauthClientSecret || undefined)
      }),
    onSuccess: (started) => {
      setSession(started.id)
      if (started.state.status === "pending") {
        window.open(started.state.authorizationUrl, "_blank", "noopener")
        toast.info("Finish the authorization in the tab that opened")
      }
    },
    onError: (error: Error) => toast.error("Could not start OAuth", { description: error.message })
  })

  // The gateway runs the flow and the caller polls; there is nothing to await
  // here, because the browser trip happens outside this page entirely.
  useEffect(() => {
    if (session === undefined) return
    const timer = setInterval(() => {
      void gateway.pollOAuth(session).then((current) => {
        if (current.state.status === "connected") {
          clearInterval(timer)
          setSession(undefined)
          setOpen(false)
          invalidate(keys.integrations, keys.connections)
          toast.success(`Connected ${integration.name}`)
        }
        if (current.state.status === "failed") {
          clearInterval(timer)
          setSession(undefined)
          toast.error("Authorization failed", { description: current.state.message })
        }
      }).catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [session, integration.name, integration.slug, invalidate])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Connect</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {integration.name}</DialogTitle>
          <DialogDescription>
            The credential is sealed by the gateway. Nothing that calls through
            it ever receives the credential itself.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="connect-name">Connection name</Label>
            <Input
              id="connect-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="default"
            />
            <p className="text-muted-foreground text-xs">
              Distinguishes several accounts on one integration — work, personal.
            </p>
          </div>
          {integration.authMethods.length === 0 ? null : (
            <div className="space-y-1.5">
              <Label>Auth method</Label>
              <Select value={template} onValueChange={setTemplate}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a method" />
                </SelectTrigger>
                <SelectContent>
                  {integration.authMethods.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.template}>
                      {candidate.label} · {candidate.kind}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {isOAuth && method !== undefined
            ? (
              <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
                <OAuthSetupPanel
                  method={method}
                  callbackUrl={callbackUrl}
                />
                <div className="space-y-1.5">
                  <Label htmlFor="oauth-client-id">OAuth client ID</Label>
                  <Input id="oauth-client-id" value={oauthClientId} onChange={(event) => setOAuthClientId(event.target.value)} placeholder="From the provider's console" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="oauth-client-secret">Client secret</Label>
                  <Input id="oauth-client-secret" type="password" value={oauthClientSecret} onChange={(event) => setOAuthClientSecret(event.target.value)} />
                </div>
                <p className="text-muted-foreground text-xs sm:col-span-2">
                  Leave both blank when the provider supports dynamic client
                  registration — the gateway registers itself.
                </p>
              </div>
            )
            : credentialVariables.length > 0
              ? (
                <div className="space-y-3">
                  {credentialVariables.map((variable) => (
                    <div key={variable} className="space-y-1.5">
                      <Label htmlFor={`credential-${variable}`}>{variable}</Label>
                      <Input
                        id={`credential-${variable}`}
                        type="password"
                        value={credentialValues[variable] ?? ""}
                        onChange={(event) => setCredentialValues({
                          ...credentialValues,
                          [variable]: event.target.value
                        })}
                        placeholder={`Paste ${variable}`}
                      />
                    </div>
                  ))}
                </div>
              )
              : (
                <div className="space-y-1.5">
                  <Label htmlFor="connect-token">Token</Label>
                  <Input
                    id="connect-token"
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="Paste the API key or token"
                  />
                </div>
              )}
        </div>
        <DialogFooter>
          {isOAuth
            ? (
              <Button
                onClick={() => startOAuth.mutate()}
                disabled={startOAuth.isPending || session !== undefined}
              >
                {session === undefined
                  ? startOAuth.isPending ? "Starting…" : "Authorize in browser"
                  : "Waiting for authorization…"}
              </Button>
            )
            : (
              <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
                {connect.isPending ? "Connecting…" : "Connect"}
              </Button>
            )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

