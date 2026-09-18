import { useEffect, useState } from "react"
import { ShieldCheck } from "lucide-react"

import { getOAuthConsent, decideOAuthConsent } from "@/lib/gateway"
import type { OAuthConsentView } from "@/lib/schemas"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"

export function OAuthConsentRoute() {
  const requestId = new URLSearchParams(window.location.search).get("request") ?? ""
  const [view, setView] = useState<OAuthConsentView | undefined>()
  const [clientId, setClientId] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void getOAuthConsent(requestId).then((next) => {
      setView(next)
      setClientId(next.clients[0]?.id ?? "")
    }).catch((cause: Error) => setError(cause.message))
  }, [requestId])

  const decide = async (decision: "approve" | "deny") => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await decideOAuthConsent(
        requestId,
        decision === "deny" ? { decision } : { decision, clientId }
      )
      window.location.assign(result.redirect)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authorization could not be completed")
      setBusy(false)
    }
  }

  const selectedClient = view?.clients.find((client) => client.id === clientId)

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" /> Authorize MCP access</CardTitle>
          <CardDescription>
            {view === undefined ? "Loading authorization request…" : `${view.application.name} wants to connect to this gateway.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {error === undefined ? null : <Alert variant="destructive"><AlertTitle>Authorization failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
          {view === undefined ? null : (
            <>
              <div className="rounded-md border p-3 text-sm">
                <p className="font-medium">{view.application.name}</p>
                <p className="text-muted-foreground mt-1 break-all text-xs">{view.application.clientIdentifier}</p>
                <p className="text-muted-foreground mt-2 text-xs">Registration: {view.application.kind === "cimd" ? "Client ID Metadata Document" : "Dynamic Client Registration compatibility"}</p>
              </div>
              <div className="grid gap-2">
                <Label>Gateway Client</Label>
                <Select
                  aria-label="Gateway Client"
                  className="w-full"
                  value={clientId}
                  onValueChange={(value) => setClientId(value ?? "")}
                  items={view.clients.map((client) => ({ value: client.id, label: client.name }))}
                />
                {selectedClient === undefined ? null : (
                  <div className="text-muted-foreground rounded-md bg-muted p-3 text-xs">
                    <p>Surface: {selectedClient.mcpSurface === "tools" ? "Effective tools" : "Gateway commands"}</p>
                    <p>Scope: {view.request.scope}</p>
                    <p>Capabilities: {selectedClient.capabilities.join(", ") || "tool access only"}</p>
                  </div>
                )}
              </div>
              <p className="text-sm">
                The application receives the selected Gateway Client’s current access profile and approval policy. Changes and revocation take effect immediately.
              </p>
            </>
          )}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button variant="outline" disabled={busy || view === undefined} onClick={() => void decide("deny")}>Deny</Button>
          <Button disabled={busy || view === undefined || clientId === ""} onClick={() => void decide("approve")}>{busy ? "Authorizing…" : "Authorize"}</Button>
        </CardFooter>
      </Card>
    </div>
  )
}
