import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ShieldCheck } from "lucide-react"
import type { OAuthConsentDecision, ProfileId } from "@integragents/contracts"

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
  const [chosenProfileId, setProfileId] = useState<ProfileId | undefined>()
  const profileId = chosenProfileId ?? view?.profiles[0]?.id
  const decide = useMutation({
    mutationFn: (decision: OAuthConsentDecision) => decideOAuthConsent(requestId, decision),
    onSuccess: (redirect) => window.location.assign(redirect)
  })
  const error = consent.error ?? decide.error
  const busy = decide.isPending || decide.isSuccess

  const selectedProfile = view?.profiles.find((profile) => profile.id === profileId)

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
                <Label>Profile</Label>
                <Select
                  aria-label="Profile"
                  className="w-full"
                  value={profileId ?? ""}
                  onValueChange={(value) => setProfileId(view.profiles.find((profile) => profile.id === value)?.id)}
                  items={view.profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
                />
                {selectedProfile === undefined ? null : (
                  <div className="text-muted-foreground rounded-md bg-muted p-3 text-xs">
                    <p>Surface: {selectedProfile.mcpSurface === "tools" ? "Tools" : "Gateway commands"}</p>
                    <p>Scope: {view.request.scope}</p>
                    <p>Gateway access: {selectedProfile.capabilities.join(", ") || "tool access only"}</p>
                  </div>
                )}
                {view.profiles.length === 0 ? <p className="text-muted-foreground text-xs">Create a profile in the dashboard first.</p> : null}
              </div>
              <p className="text-sm">
                {view.application.name} can use the tools the profile turns on, and its calls are recorded under its name. You can revoke it from the profile at any time.
              </p>
            </>
          )}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button variant="outline" disabled={busy || view === undefined} onClick={() => decide.mutate({ decision: "deny" })}>Deny</Button>
          <Button disabled={busy || profileId === undefined} onClick={() => { if (profileId !== undefined) decide.mutate({ decision: "approve", profileId }) }}>{busy ? "Authorizing…" : "Authorize"}</Button>
        </CardFooter>
      </Card>
    </div>
  )
}
