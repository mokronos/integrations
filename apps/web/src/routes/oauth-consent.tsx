import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ShieldCheck } from "lucide-react"
import type { ClientId, OAuthConsentDecision } from "@mokronos/integrations-contracts"

import { getOAuthConsent, decideOAuthConsent } from "@/lib/gateway"
import { useMutation } from "@/lib/queries"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"

export function OAuthConsentRoute() {
  const requestId = new URLSearchParams(window.location.search).get("request") ?? ""
  const consent = useQuery({
    queryKey: ["oauth-consent", requestId],
    queryFn: () => getOAuthConsent(requestId),
    refetchOnWindowFocus: false
  })
  const view = consent.data
  const [chosenClientId, setClientId] = useState<ClientId | undefined>()
  const clientId = chosenClientId ?? view?.clients[0]?.id
  const decide = useMutation({
    mutationFn: (decision: OAuthConsentDecision) => decideOAuthConsent(requestId, decision),
    onSuccess: (redirect) => window.location.assign(redirect)
  })
  const error = consent.error ?? decide.error
  const busy = decide.isPending || decide.isSuccess

  const selectedClient = view?.clients.find((client) => client.id === clientId)

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" /> Authorize MCP access</CardTitle>
          <CardDescription>
            {view === undefined ? <Skeleton className="h-5 w-64 max-w-full" /> : `${view.application.name} wants to connect to this gateway.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {error === null ? null : <Alert variant="destructive"><AlertTitle>Authorization failed</AlertTitle><AlertDescription>{error.message}</AlertDescription></Alert>}
          {view === undefined ? <div className="space-y-5" aria-hidden><Skeleton className="h-24 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-12 w-full" /></div> : (
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
                  value={clientId ?? ""}
                  onValueChange={(value) => setClientId(view.clients.find((client) => client.id === value)?.id)}
                  items={view.clients.map((client) => ({ value: client.id, label: client.name }))}
                />
                {selectedClient === undefined ? null : (
                  <div className="text-muted-foreground rounded-md bg-muted p-3 text-xs">
                    <p>Surface: {selectedClient.mcpSurface === "tools" ? "Tools" : "Gateway commands"}</p>
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
          <Button variant="outline" disabled={busy || view === undefined} onClick={() => decide.mutate({ decision: "deny" })}>Deny</Button>
          <Button disabled={busy || clientId === undefined} onClick={() => { if (clientId !== undefined) decide.mutate({ decision: "approve", clientId }) }}>{busy ? "Authorizing…" : "Authorize"}</Button>
        </CardFooter>
      </Card>
    </div>
  )
}
