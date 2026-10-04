import { useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { Page } from "@/components/page"
import { useSession } from "@/components/auth-gate"
import { Bell, Plus } from "lucide-react"
import type { ApprovalDestinationId } from "@integragents/contracts"
import { changeEmail, changePassword, createApprovalDestination, deleteAccount, deleteApprovalDestination } from "@/lib/gateway"
import { keys, useApprovalDestinations, useInvalidate, useMutation } from "@/lib/queries"
import { ConfirmButton } from "@/components/ui/confirm-button"
import { CopyField } from "@/components/ui/copy-field"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
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
  CardAction,
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

export function SettingsRoute() {
  const session = useSession()
  if (session?.authenticated !== true) return null
  if (session.kind !== "session") {
    return (
      <Page title="Settings">
        <div className="grid max-w-2xl gap-6">
          <NotificationDestinations />
          <Card>
            <CardHeader>
              <CardTitle>Account</CardTitle>
              <CardDescription>
                This browser uses the local gateway's operator key, so there is no account to manage.
                Account settings appear on a hosted gateway once you sign in.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </Page>
    )
  }
  return (
    <Page title="Settings">
      <div className="grid max-w-2xl gap-6">
        <NotificationDestinations />
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>Signed in as {session.email}.</CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>
              Tenant{" "}
              <code className="text-xs">{session.tenantId}</code>
              . Connections, profiles, and approvals are private to it.
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

function CreateDestination() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const invalidate = useInvalidate()
  const create = useMutation({
    mutationFn: () => createApprovalDestination({ name: name.trim(), url: url.trim() }),
    onSuccess: () => invalidate(keys.approvalDestinations),
    onError: (error: Error) => toast.error("Could not add the destination", { description: error.message })
  })
  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) {
      create.reset()
      setName("")
      setUrl("")
    }
  }
  const secret = create.data?.signingSecret
  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger render={<Button size="sm" variant="outline" />}><Plus className="size-4" />Add webhook</DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{secret === undefined ? "Add a webhook" : "Copy the signing secret now"}</DialogTitle>
        <DialogDescription>
          {secret === undefined
            ? "The gateway posts here whenever a call asks for approval. A notification carries no arguments and cannot approve anything."
            : "Use it to verify each notification's signature. It cannot be shown again."}
        </DialogDescription>
      </DialogHeader>
      {secret === undefined
        ? <div className="space-y-4">
          <div className="space-y-1.5"><Label htmlFor="destination-name">Name</Label><Input id="destination-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="destination-url">Public HTTPS URL</Label><Input id="destination-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/approval-events" /></div>
        </div>
        : <CopyField value={secret} label="Signing secret" />}
      <DialogFooter>
        {secret === undefined
          ? <Button disabled={!name.trim() || !url.trim() || create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Adding…" : "Add"}</Button>
          : <Button onClick={() => changeOpen(false)}>Done</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

function DeleteDestination({ id, name }: { readonly id: ApprovalDestinationId; readonly name: string }) {
  const invalidate = useInvalidate()
  const remove = useMutation({
    mutationFn: () => deleteApprovalDestination(id),
    onSuccess: () => { invalidate(keys.approvalDestinations, keys.profiles); toast.success(`${name} removed`) },
    onError: (error: Error) => toast.error("Could not remove the destination", { description: error.message })
  })
  return <ConfirmButton
    label="Remove"
    title={`Remove ${name}?`}
    description="Profiles stop notifying it. Approvals already sent are unaffected."
    confirmLabel="Remove"
    pendingLabel="Removing…"
    pending={remove.isPending}
    onConfirm={() => remove.mutateAsync().then(() => undefined)}
  />
}

function NotificationDestinations() {
  const destinations = useApprovalDestinations()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Approval notifications</CardTitle>
        <CardDescription>Webhooks a profile can notify when a call asks for approval. Choose them per profile under its settings.</CardDescription>
        <CardAction><CreateDestination /></CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {destinations.isPending ? <Skeleton className="h-14 w-full" /> : null}
        {destinations.error ? <Alert variant="destructive"><AlertTitle>Could not load destinations</AlertTitle><AlertDescription>{destinations.error.message}</AlertDescription></Alert> : null}
        {!destinations.isPending && (destinations.data ?? []).length === 0 ? <p className="text-muted-foreground text-sm">No webhooks yet.</p> : null}
        {(destinations.data ?? []).map((destination) => (
          <div key={destination.id} className="flex items-center gap-3 rounded-lg border p-3">
            <Bell className="text-muted-foreground size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{destination.name}</p>
              <p className="text-muted-foreground truncate text-xs">{destination.url}</p>
            </div>
            <DeleteDestination id={destination.id} name={destination.name} />
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
          Removes your sign-in, sessions, profiles, API keys, and approval
          history. Vendor connections stored in the integration host's credential store
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
