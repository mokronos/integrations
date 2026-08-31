import { useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { Page } from "@/components/page"
import { useSession } from "@/components/auth-gate"
import { changeEmail, changePassword, deleteAccount } from "@/lib/gateway"
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

/** The signed-in human's own page. Agents never see it — they hold client
 *  keys, not accounts — so everything here answers to a password. */
export function AccountRoute() {
  const session = useSession()
  if (session?.authenticated !== true) return null
  if (session.kind !== "session") {
    return (
      <Page title="Account" description="This local control plane is authenticated by its loopback credential.">
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>Local operator</CardTitle>
            <CardDescription>
              Human account settings appear on hosted gateways after signing in.
              This browser is borrowing the local administrative client while it
              remains on loopback.
            </CardDescription>
          </CardHeader>
        </Card>
      </Page>
    )
  }
  const email = session.email

  return (
    <Page
      title="Account"
      description={`Signed in as ${email}.`}
    >
      <div className="grid max-w-2xl gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>
              Tenant{" "}
              <code className="text-xs">
                {session && "tenantId" in session ? session.tenantId : "?"}
              </code>
              . Connections, clients, and approvals are private to it.
            </CardDescription>
          </CardHeader>
        </Card>

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

function ChangeEmailCard() {
  const navigate = useNavigate()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await changeEmail({ email, password })
      // A full reload re-runs the session check, which reads the new email.
      navigate(0)
    } catch (error) {
      toast.error("Could not change email", {
        description: error instanceof Error ? error.message : undefined
      })
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change email</CardTitle>
        <CardDescription>Confirm with your current password.</CardDescription>
      </CardHeader>
      <form onSubmit={(event) => void submit(event)}>
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
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Update email"}
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
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      const revoked = hasPassword
        ? await changePassword({ currentPassword, newPassword })
        : await changePassword({ newPassword })
      toast.success("Password updated", {
        description: revoked > 0
          ? `${revoked} other session${revoked === 1 ? "" : "s"} signed out.`
          : undefined
      })
      setCurrentPassword("")
      setNewPassword("")
      if (!hasPassword) navigate(0)
    } catch (error) {
      toast.error("Could not change password", {
        description: error instanceof Error ? error.message : undefined
      })
    } finally {
      setBusy(false)
    }
  }

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
      <form onSubmit={(event) => void submit(event)}>
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
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : hasPassword ? "Update password" : "Add password"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function DeleteAccountCard({ hasPassword }: { readonly hasPassword: boolean }) {
  const [password, setPassword] = useState("")
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  const submit = async () => {
    setBusy(true)
    try {
      await deleteAccount(hasPassword ? { password } : {})
      // Everything this account owned is gone; the reload lands on the login
      // card because the session went with the subject.
      navigate(0)
    } catch (error) {
      toast.error("Could not delete the account", {
        description: error instanceof Error ? error.message : undefined
      })
      setBusy(false)
    }
  }

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
          <AlertDialogTrigger asChild>
            <Button variant="destructive" disabled={!hasPassword}>Delete account…</Button>
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
                  void submit()
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
