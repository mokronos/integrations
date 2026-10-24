import { useState } from "react"
import type { ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { ShieldCheck, SquareTerminal } from "lucide-react"
import type { OAuthConsentDecision, ProfileId } from "@integragents/contracts"

import type { OAuthConsent } from "@/lib/gateway"
import { decideDeviceConsent, decideOAuthConsent, getDeviceConsent, getOAuthConsent } from "@/lib/gateway"
import { useMutation } from "@/lib/queries"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"

function ConsentPage({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-xl">{children}</Card>
    </div>
  )
}

function ConsentError({ title, error }: { readonly title: string; readonly error: Error | null }) {
  return error === null ? null : (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  )
}

/** The application asking, the profile it would act as, and the person's answer. */
function ConsentForm({
  title,
  view,
  error,
  busy,
  notice,
  onDecide
}: {
  readonly title: string
  readonly view: OAuthConsent | undefined
  readonly error: Error | null
  readonly busy: boolean
  readonly notice?: ReactNode
  readonly onDecide: (decision: OAuthConsentDecision) => void
}) {
  const [chosenProfileId, setProfileId] = useState<ProfileId | undefined>()
  const profileId = chosenProfileId ?? view?.profiles[0]?.id
  const selectedProfile = view?.profiles.find((profile) => profile.id === profileId)

  return (
    <>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5" /> {title}
        </CardTitle>
        <CardDescription>
          {view === undefined ? (
            <Skeleton className="h-5 w-64 max-w-full" />
          ) : (
            `${view.application.name} wants to connect to this gateway.`
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ConsentError title="Authorization failed" error={error} />
        {notice}
        {view === undefined ? (
          <div className="space-y-5" aria-hidden>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : (
          <>
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">{view.application.name}</p>
              <p className="text-muted-foreground mt-1 break-all text-xs">{view.application.clientIdentifier}</p>
              <p className="text-muted-foreground mt-2 text-xs">
                Registration:{" "}
                {view.application.kind === "cimd"
                  ? "Client ID Metadata Document"
                  : "Dynamic Client Registration compatibility"}
              </p>
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
              {view.profiles.length === 0 ? (
                <p className="text-muted-foreground text-xs">Create a profile in the dashboard first.</p>
              ) : null}
            </div>
            <p className="text-sm">
              {view.application.name} can use the tools the profile turns on, and its calls are recorded under its name.
              You can revoke it from the profile at any time.
            </p>
          </>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="outline" disabled={busy || view === undefined} onClick={() => onDecide({ decision: "deny" })}>
          Deny
        </Button>
        <Button
          disabled={busy || profileId === undefined}
          onClick={() => {
            if (profileId !== undefined) onDecide({ decision: "approve", profileId })
          }}
        >
          {busy ? "Authorizing…" : "Authorize"}
        </Button>
      </CardFooter>
    </>
  )
}

export function OAuthConsentRoute() {
  const requestId = new URLSearchParams(window.location.search).get("request") ?? ""
  const consent = useQuery({
    queryKey: ["oauth-consent", requestId],
    queryFn: () => getOAuthConsent(requestId),
    refetchOnWindowFocus: false
  })
  const decide = useMutation({
    mutationFn: (decision: OAuthConsentDecision) => decideOAuthConsent(requestId, decision),
    onSuccess: (redirect) => window.location.assign(redirect)
  })

  return (
    <ConsentPage>
      <ConsentForm
        title="Authorize MCP access"
        view={consent.data}
        error={consent.error ?? decide.error}
        busy={decide.isPending || decide.isSuccess}
        onDecide={decide.mutate}
      />
    </ConsentPage>
  )
}

/**
 * Where a person confirms the code a device without a browser, such as `i`
 * in an agent's sandbox, showed them. The device then holds a token for the
 * profile chosen here; the person never hands it a key.
 */
export function OAuthDeviceRoute() {
  const [typed, setTyped] = useState(() => new URLSearchParams(window.location.search).get("user_code") ?? "")
  const [code, setCode] = useState(typed)
  const consent = useQuery({
    queryKey: ["oauth-device", code],
    queryFn: () => getDeviceConsent(code),
    enabled: code !== "",
    refetchOnWindowFocus: false,
    retry: false
  })
  const decide = useMutation({
    mutationFn: (decision: OAuthConsentDecision) => decideDeviceConsent(code, decision)
  })

  if (decide.isSuccess) {
    return (
      <ConsentPage>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SquareTerminal className="size-5" /> {decide.data ? "Device authorized" : "Request denied"}
          </CardTitle>
          <CardDescription>
            {decide.data
              ? `${consent.data?.application.name ?? "The device"} is signed in. You can close this tab; the device finishes signing in the next time it runs \`i login\`.`
              : "The device was refused and holds nothing. You can close this tab."}
          </CardDescription>
        </CardHeader>
      </ConsentPage>
    )
  }

  if (code === "" || consent.error !== null) {
    return (
      <ConsentPage>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SquareTerminal className="size-5" /> Connect a device
          </CardTitle>
          <CardDescription>Enter the code the terminal shows.</CardDescription>
        </CardHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setCode(typed.trim())
          }}
        >
          <CardContent className="space-y-3">
            <ConsentError title="That code is not waiting for approval" error={consent.error} />
            <Label htmlFor="user-code">Code</Label>
            <Input
              id="user-code"
              autoFocus
              autoComplete="off"
              placeholder="BCDF-GHJK"
              className="font-mono uppercase tracking-widest"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </CardContent>
          <CardFooter className="mt-4 justify-end">
            <Button type="submit" disabled={typed.trim() === ""}>
              Continue
            </Button>
          </CardFooter>
        </form>
      </ConsentPage>
    )
  }

  return (
    <ConsentPage>
      <ConsentForm
        title="Authorize a device"
        view={consent.data}
        error={decide.error}
        busy={decide.isPending}
        notice={
          <Alert>
            <AlertTitle className="font-mono tracking-widest">{code.toUpperCase()}</AlertTitle>
            <AlertDescription>
              Approve only if the terminal you started shows this same code. Whoever holds the device gets the profile's
              access.
            </AlertDescription>
          </Alert>
        }
        onDecide={decide.mutate}
      />
    </ConsentPage>
  )
}
