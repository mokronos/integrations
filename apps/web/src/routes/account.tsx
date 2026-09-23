import { useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { Page } from "@/components/page"
import { useSession } from "@/components/auth-gate"
import { changeEmail, changePassword, deleteAccount, revokeOAuthGrant } from "@/lib/gateway"
import { keys, useInvalidate, useMutation, useOAuthGrants } from "@/lib/queries"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { pluralise } from "@/lib/format"

export function AccountRoute() {
  const session = useSession()
  if (session?.authenticated !== true) return null
  if (session.kind !== "session") {
    return (
      <Page title="Account" description="This local control plane is authenticated by its loopback credential.">
        <div className="grid max-w-2xl gap-6"><Card>
          <CardHeader>
            <CardTitle>Local operator</CardTitle>
            <CardDescription>
              Human account settings appear on hosted gateways after signing in.
              This browser is borrowing the local administrative client while it
              remains on loopback.
            </CardDescription>
          </CardHeader>
        </Card><OAuthApplicationsCard /></div>
      </Page>
    )
  }
  return (
    <Page title="Account" description={`Signed in as ${session.email}.`}>
      <div className="grid max-w-2xl gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>
              Tenant{" "}
              <code className="text-xs">{session.tenantId}</code>
              . Connections, clients, and approvals are private to it.
            </CardDescription>
          </CardHeader>
        </Card>

        <OAuthApplicationsCard />

        <Card>
          <CardHeader>
            <CardTitle>Sign-in methods</CardTitle>
            <CardDescription>
              {session.identityProviders.includes("google")
                ? "Google is linked to this account."
                : "This account currently uses a password."}
            </CardDescription>
          </CardHeader>
        </Card>

        {session.hasPassword ? <ChangeEmailCard /> : null}
        <ChangePasswordCard hasPassword={session.hasPassword} />
        <DeleteAccountCard hasPassword={session.hasPassword} />
      </div>
    </Page>
  )
}

function OAuthApplicationsCard() {
  const grants = useOAuthGrants()
  const invalidate = useInvalidate()
  const revoke = useMutation({
    mutationFn: revokeOAuthGrant,
    onSuccess: () => invalidate(keys.oauthGrants)
  })
  const active = grants.data?.filter((grant) => grant.revokedAt === null) ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected MCP applications</CardTitle>
        <CardDescription>
          Browser-authorized applications. Revoking one immediately invalidates its access and refresh tokens.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {grants.isPending ? <div className="space-y-3" aria-hidden><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div> : null}
        {grants.error ? <Alert variant="destructive"><AlertTitle>Could not load applications</AlertTitle><AlertDescription>{grants.error.message}</AlertDescription></Alert> : null}
        {!grants.isPending && active.length === 0 ? <p className="text-muted-foreground text-sm">No MCP applications are connected.</p> : null}
        {active.map((grant) => (
          <div key={grant.id} className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <div className="min-w-0 text-sm">
              <p className="font-medium">{grant.applicationName}</p>
              <p className="text-muted-foreground">Acts as {grant.clientName} · authorized by {grant.subjectEmail}</p>
              <p className="text-muted-foreground mt-1 text-xs">
                {grant.applicationKind === "cimd" ? "Client metadata document" : "Dynamic registration"}
                {grant.lastUsedAt === null ? " · Not used yet" : ` · Last used ${grant.lastUsedAt.toLocaleString()}`}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={revoke.isPending && revoke.variables === grant.id}
              onClick={() => revoke.mutate(grant.id)}
            >
              Revoke
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function ChangeEmailCard() {
  const navigate = useNavigate()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const save = useMutation({
    mutationFn: () => changeEmail({ email, password }),
    onSuccess: () => navigate(0),
    onError: (error: Error) => toast.error("Could not change email", { description: error.message })
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change email</CardTitle>
        <CardDescription>Confirm with your current password.</CardDescription>
      </CardHeader>
      <form onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="new-email">New email</Label>
            <Input
              id="new-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="email-password">Current password</Label>
            <Input
              id="email-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={save.isPending || save.isSuccess}>
            {save.isPending ? "Saving…" : "Update email"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function ChangePasswordCard({ hasPassword }: { readonly hasPassword: boolean }) {
  const navigate = useNavigate()
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const save = useMutation({
    mutationFn: () => changePassword(hasPassword ? { currentPassword, newPassword } : { newPassword }),
    onSuccess: (revoked) => {
      toast.success("Password updated", {
        description: revoked > 0 ? `${pluralise(revoked, "other session")} signed out.` : undefined
      })
      setCurrentPassword("")
      setNewPassword("")
      if (!hasPassword) navigate(0)
    },
    onError: (error: Error) => toast.error("Could not change password", { description: error.message })
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{hasPassword ? "Change password" : "Add a password"}</CardTitle>
        <CardDescription>
          {hasPassword
            ? "Other devices stay signed out; this one keeps its session."
            : "A password enables email changes and password-confirmed account deletion."}
        </CardDescription>
      </CardHeader>
      <form onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
        <CardContent className="grid gap-4">
          {hasPassword
            ? (
              <div className="grid gap-2">
                <Label htmlFor="current-password">Current password</Label>
                <Input
                  id="current-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </div>
            )
            : null}
          <div className="grid gap-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">At least 8 characters.</p>
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : hasPassword ? "Update password" : "Add password"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function DeleteAccountCard({ hasPassword }: { readonly hasPassword: boolean }) {
  const [password, setPassword] = useState("")
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const remove = useMutation({
    mutationFn: () => deleteAccount({ password }),
    onSuccess: () => navigate(0),
    onError: (error: Error) => toast.error("Could not delete the account", { description: error.message })
  })
  const busy = remove.isPending || remove.isSuccess

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>
          Removes your sign-in, sessions, clients, API keys, policies, and approval
          history. Vendor connections stored in the integrations's credential store
          are not reclaimed. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger render={<Button variant="destructive" disabled={!hasPassword} />}>
            Delete account…
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete your account?</AlertDialogTitle>
              <AlertDialogDescription>
                Your workspace and everything scoped to it is removed. If others
                share it, only your membership goes.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="delete-confirm-password">Current password</Label>
              <Input
                id="delete-confirm-password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Alert variant="destructive">
              <AlertTitle>Final</AlertTitle>
              <AlertDescription>There is no undo.</AlertDescription>
            </Alert>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Keep account</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy || !hasPassword || password.length === 0}
                onClick={(event) => {
                  event.preventDefault()
                  remove.mutate()
                }}
              >
                {busy ? "Deleting…" : "Delete forever"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
      {!hasPassword
        ? (
          <CardFooter>
            <p className="text-muted-foreground text-xs">Add a password above before deleting this account.</p>
          </CardFooter>
        )
        : null}
    </Card>
  )
}
