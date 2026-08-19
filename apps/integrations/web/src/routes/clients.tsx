import { useState } from "react"
import { Link } from "react-router"
import { Copy, KeyRound, ShieldAlert } from "lucide-react"
import { toast } from "sonner"

import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { when } from "@/lib/format"
import * as gateway from "@/lib/gateway"
import { keys, useClients, useInvalidate, useMutation } from "@/lib/queries"
import type { Client } from "@/lib/schemas"

function CreateClientDialog() {
  const invalidate = useInvalidate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [mayMutate, setMayMutate] = useState(false)

  const create = useMutation({
    mutationFn: () => gateway.createClient({ name: name.trim(), mayMutate }),
    onSuccess: (client) => {
      invalidate(keys.clients)
      toast.success(`Created ${client.name}`, { description: "Issue it a key to make it usable." })
      setOpen(false)
      setName("")
      setMayMutate(false)
    },
    onError: (error: Error) => toast.error("Could not create client", { description: error.message })
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New client</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New client</DialogTitle>
          <DialogDescription>
            A client is something you delegate to — an agent, a sandbox, a
            deployment. It holds no connection of its own, only grants.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="client-name">Name</Label>
            <Input
              id="client-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="research-agent"
            />
          </div>
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch id="client-mutate" checked={mayMutate} onCheckedChange={setMayMutate} />
            <div className="space-y-1">
              <Label htmlFor="client-mutate">May change the catalog and grants</Label>
              <p className="text-muted-foreground text-xs">
                Leave this off for anything running agent code. A client that can
                edit grants can grant itself whatever it likes, so a
                prompt-injected agent with this on has no ceiling.
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={name.trim().length === 0 || create.isPending}
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The plaintext exists exactly once, here. Nothing stores it, including this
 *  page — closing the dialog is the end of it. */
function IssuedKeyDialog({
  secret,
  onClose
}: {
  readonly secret: string | undefined
  readonly onClose: () => void
}) {
  return (
    <Dialog open={secret !== undefined} onOpenChange={(open) => open ? undefined : onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Key issued</DialogTitle>
          <DialogDescription>
            Copy it now. The gateway keeps only a hash, so this is the one and
            only time it can be shown.
          </DialogDescription>
        </DialogHeader>
        <code className="bg-muted block break-all rounded-md p-3 font-mono text-sm">
          {secret}
        </code>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(secret ?? "")
              toast.success("Copied")
            }}
          >
            <Copy className="size-4" />
            Copy
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ClientRow({ client }: { readonly client: Client }) {
  const invalidate = useInvalidate()
  const [secret, setSecret] = useState<string | undefined>()

  const issue = useMutation({
    mutationFn: () => gateway.issueKey(client.id),
    onSuccess: (key) => setSecret(key.secret),
    onError: (error: Error) => toast.error("Could not issue a key", { description: error.message })
  })

  const revoke = useMutation({
    mutationFn: () => gateway.revokeClient(client.id),
    onSuccess: (result) => {
      invalidate(keys.clients, ["approvals"])
      toast.success(`Revoked ${client.name}`, {
        description: result.cancelledApprovals === undefined || result.cancelledApprovals === 0
          ? undefined
          : `${result.cancelledApprovals} frozen call(s) cancelled`
      })
    },
    onError: (error: Error) => toast.error("Could not revoke", { description: error.message })
  })

  const revoked = client.revokedAt !== null

  return (
    <TableRow className={revoked ? "opacity-55" : undefined}>
      <TableCell>
        <Link className="font-medium hover:underline" to={`/clients/${client.id}`}>
          {client.name}
        </Link>
        <div className="text-muted-foreground font-mono text-xs">{client.id}</div>
      </TableCell>
      <TableCell>
        {client.mayMutate
          ? (
            <Badge variant="destructive" className="gap-1">
              <ShieldAlert className="size-3" />
              may mutate
            </Badge>
          )
          : <Badge variant="secondary">delegated only</Badge>}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">{when(client.createdAt)}</TableCell>
      <TableCell>
        {revoked ? <Badge variant="outline">revoked {when(client.revokedAt)}</Badge> : null}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => issue.mutate()}
            disabled={revoked || issue.isPending}
          >
            <KeyRound className="size-3" />
            Issue key
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" disabled={revoked}>Revoke</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Revoke {client.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every key it holds stops working immediately, and any call it
                  froze awaiting approval is cancelled rather than left armed.
                  This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => revoke.mutate()}>Revoke</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <IssuedKeyDialog secret={secret} onClose={() => setSecret(undefined)} />
      </TableCell>
    </TableRow>
  )
}

export function ClientsRoute() {
  const clients = useClients()

  return (
    <Page
      title="Clients"
      description="Who may call through this gateway, and how far each one reaches."
      actions={
        <>
          <CreateClientDialog />
          <ReloadButton onClick={() => void clients.refetch()} busy={clients.isFetching} />
        </>
      }
    >
      <QueryError error={clients.error} />
      {clients.isPending
        ? <LoadingRows />
        : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Authority</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead />
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(clients.data ?? []).length === 0
                    ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-muted-foreground py-10 text-center">
                          No clients yet.
                        </TableCell>
                      </TableRow>
                    )
                    : (clients.data ?? []).map((client) => (
                      <ClientRow key={client.id} client={client} />
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
    </Page>
  )
}
