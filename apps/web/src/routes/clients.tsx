import { useState } from "react"
import { Link } from "react-router"
import { Copy, KeyRound, ShieldAlert } from "lucide-react"
import { toast } from "sonner"
import { whenPresent } from "@mokronos/contracts"

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
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
import { keys, useClients, useInvalidate, useMutation, usePolicies } from "@/lib/queries"
import type { Client, PolicySummary } from "@/lib/schemas"
import { decodePolicyId } from "@/lib/schemas"

function CreateClientDialog() {
  const invalidate = useInvalidate()
  const policies = usePolicies()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [mayProvision, setMayProvision] = useState(false)
  const [mayAdminister, setMayAdminister] = useState(false)
  const [returnLink, setReturnLink] = useState(true)
  const [webhooks, setWebhooks] = useState("")
  const [policyId, setPolicyId] = useState("__default__")
  const parsedWebhooks = webhooks.split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  const validWebhooks = parsedWebhooks.length <= 10 &&
    parsedWebhooks.every((url) => /^https?:\/\/[^\s]+$/.test(url))

  const create = useMutation({
    mutationFn: () => {
      const capabilities: Array<"provision_connections" | "administer_gateway"> = []
      if (mayProvision) capabilities.push("provision_connections")
      if (mayAdminister) capabilities.push("administer_gateway")
      return gateway.createClient({
        name: name.trim(),
        ...whenPresent("policyId", policyId === "__default__" ? undefined : decodePolicyId(policyId)),
        capabilities,
        approvalDelivery: {
          returnLink,
          webhooks: parsedWebhooks
        }
      })
    },
    onSuccess: (client) => {
      invalidate(keys.clients)
      toast.success(`Created ${client.name}`, { description: "Issue it a key to make it usable." })
      setOpen(false)
      setName("")
      setMayProvision(false)
      setMayAdminister(false)
      setReturnLink(true)
      setWebhooks("")
      setPolicyId("__default__")
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
            deployment. Its assigned policy controls which connected tools it can use.
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
          <div className="space-y-1.5">
            <Label htmlFor="client-policy">Policy</Label>
            <Select value={policyId} onValueChange={setPolicyId}>
              <SelectTrigger id="client-policy" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">
                  Gateway default{(policies.data ?? []).find((summary) => summary.policy.isDefault)?.policy.name === undefined
                    ? ""
                    : `: ${(policies.data ?? []).find((summary) => summary.policy.isDefault)?.policy.name}`}
                </SelectItem>
                {(policies.data ?? []).filter((summary) => !summary.policy.isDefault).map((summary) => (
                  <SelectItem key={summary.policy.id} value={summary.policy.id}>{summary.policy.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Leave the gateway default selected to let the backend resolve the default policy.
            </p>
          </div>
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch
              id="client-provision"
              checked={mayProvision}
              onCheckedChange={setMayProvision}
            />
            <div className="space-y-1">
              <Label htmlFor="client-provision">May provision connections</Label>
              <p className="text-muted-foreground text-xs">
                Allows catalog discovery and connection setup. Ordinary runtime
                clients generally need only policy-controlled tools, so this starts off.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch
              id="client-administer"
              checked={mayAdminister}
              onCheckedChange={setMayAdminister}
            />
            <div className="space-y-1">
              <Label htmlFor="client-administer">May administer the gateway</Label>
              <p className="text-muted-foreground text-xs">
                Allows managing clients, keys, policies, approvals, and audit. Leave
                it off for anything running agent code.
              </p>
            </div>
          </div>
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-start gap-3">
              <Switch id="client-return-link" checked={returnLink} onCheckedChange={setReturnLink} />
              <div className="space-y-1">
                <Label htmlFor="client-return-link">Return an approval link</Label>
                <p className="text-muted-foreground text-xs">
                  Pending calls receive a dashboard URL. The URL still requires a human sign-in.
                </p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="client-webhooks">Approval notification webhooks</Label>
              <Textarea
                id="client-webhooks"
                value={webhooks}
                onChange={(event) => setWebhooks(event.target.value)}
                placeholder="https://automation.example/hooks/approvals"
              />
              <p className={validWebhooks ? "text-muted-foreground text-xs" : "text-destructive text-xs"}>
                One HTTP(S) URL per line, up to 10. Notifications omit arguments and credentials.
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={name.trim().length === 0 || !validWebhooks || create.isPending}
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

function ClientRow({
  client,
  policies
}: {
  readonly client: Client
  readonly policies: ReadonlyArray<PolicySummary>
}) {
  const invalidate = useInvalidate()
  const [secret, setSecret] = useState<string | undefined>()
  const assignedPolicyAvailable = policies.some((summary) => summary.policy.id === client.policyId)

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

  const assignPolicy = useMutation({
    mutationFn: (policyId: string) => gateway.assignPolicy({
      clientId: client.id,
      policyId: decodePolicyId(policyId)
    }),
    onSuccess: (updated) => {
      invalidate(keys.clients, keys.policies, keys.clientTools(client.id), keys.overview)
      toast.success(`${updated.name} now uses the selected policy`)
    },
    onError: (error: Error) => toast.error("Could not change policy", { description: error.message })
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
        {client.capabilities.includes("administer_gateway")
          ? (
            <Badge variant="destructive" className="gap-1">
              <ShieldAlert className="size-3" />
              administrator
            </Badge>
          )
          : <Badge variant="secondary">client</Badge>}
      </TableCell>
      <TableCell>
        <Select
          value={client.policyId}
          onValueChange={(policyId) => assignPolicy.mutate(policyId)}
          disabled={revoked || assignPolicy.isPending}
        >
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            {assignedPolicyAvailable ? null : (
              <SelectItem value={client.policyId}>{client.policyId} (unavailable)</SelectItem>
            )}
            {policies.map((summary) => (
              <SelectItem key={summary.policy.id} value={summary.policy.id}>
                {summary.policy.name}{summary.policy.isDefault ? " (default)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
  const policies = usePolicies()

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
      <QueryError error={clients.error ?? policies.error} />
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
                    <TableHead>Policy</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead />
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(clients.data ?? []).length === 0
                    ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-muted-foreground py-10 text-center">
                          No clients yet.
                        </TableCell>
                      </TableRow>
                    )
                    : (clients.data ?? []).map((client) => (
                      <ClientRow
                        key={client.id}
                        client={client}
                        policies={policies.data ?? []}
                      />
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
    </Page>
  )
}
