import { Trash2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

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
import {
  TableCell,
  TableRow
} from "@/components/ui/table"
import { connectionLabel, when } from "@/lib/format"
import type { ConnectionRefInput } from "@/lib/gateway"
import * as gateway from "@/lib/gateway"
import {
  keys,
  useIntegrations,
  useInvalidate,
  useMutation
} from "@/lib/queries"
import type { Grant, GrantDecision } from "@/lib/schemas"
import { decodeGrantDecision } from "@/lib/schemas"

const decisionLabel = {
  allow: "Allow",
  require_approval: "Ask a human"
} satisfies Readonly<Record<GrantDecision, string>>
export function GrantDialog({ clientId }: { readonly clientId: string }) {
  const invalidate = useInvalidate()
  const integrations = useIntegrations()
  const [open, setOpen] = useState(false)
  const [slug, setSlug] = useState("")
  const [address, setAddress] = useState("")
  const [alias, setAlias] = useState("")
  const [subject, setSubject] = useState("")
  const [decision, setDecision] = useState<GrantDecision>("require_approval")

  const integration = integrations.data?.find((candidate) => candidate.slug === slug)
  const tool = integration?.tools.find((candidate) => candidate.address === address)
  const connection = integration?.connections.find(
    (candidate) => candidate.name === tool?.connection
  )

  // Only connected integrations can be granted: a grant names a connection, and
  // an unconnected integration has none to name.
  const connectable = (integrations.data ?? []).filter(
    (candidate) => candidate.connections.length > 0 && candidate.tools.length > 0
  )

  const needsSubject = connection?.owner === "user"
  const aliasIsValid = /^[a-z][a-z0-9-]*$/.test(alias)

  const create = useMutation({
    mutationFn: () => {
      if (tool === undefined || connection === undefined) {
        throw new Error("Pick a tool first")
      }
      const reference: ConnectionRefInput = connection.owner === "user"
        ? {
          owner: "user",
          subject: subject.trim(),
          integration: connection.integration,
          name: connection.name
        }
        : {
          owner: "org",
          integration: connection.integration,
          name: connection.name
        }
      return gateway.createGrant({
        clientId,
        alias,
        tool: tool.name,
        connection: reference,
        decision
      })
    },
    onSuccess: () => {
      invalidate(keys.grants(clientId))
      toast.success("Granted")
      setOpen(false)
      setAddress("")
      setAlias("")
    },
    onError: (error: Error) => toast.error("Could not grant", { description: error.message })
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Grant a tool</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Grant a tool</DialogTitle>
          <DialogDescription>
            One tool, through one connection, under a name this client chooses.
            Everything not granted is invisible to it rather than visible and
            failing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Integration</Label>
            <Select
              value={slug}
              onValueChange={(value) => {
                setSlug(value)
                setAddress("")
              }}
            >
              <SelectTrigger><SelectValue placeholder="Pick an integration" /></SelectTrigger>
              <SelectContent>
                {connectable.map((candidate) => (
                  <SelectItem key={candidate.slug} value={candidate.slug}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {connectable.length === 0
              ? (
                <p className="text-muted-foreground text-xs">
                  Nothing is connected yet — a grant has to name a connection.
                </p>
              )
              : null}
          </div>

          <div className="space-y-1.5">
            <Label>Tool</Label>
            <Select
              value={address}
              onValueChange={(value) => {
                setAddress(value)
                const selected = integration?.tools.find((candidate) => candidate.address === value)
                if (selected !== undefined) setDecision(selected.defaultDecision)
              }}
              disabled={integration === undefined}
            >
              <SelectTrigger><SelectValue placeholder="Pick a tool" /></SelectTrigger>
              <SelectContent>
                {(integration?.tools ?? []).map((candidate) => (
                  <SelectItem key={candidate.address} value={candidate.address}>
                    {candidate.name} · {candidate.connection}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tool === undefined || tool.description.length === 0
              ? null
              : <p className="text-muted-foreground text-xs">{tool.description}</p>}
          </div>

          {needsSubject
            ? (
              <div className="space-y-1.5">
                <Label htmlFor="grant-subject">Subject</Label>
                <Input
                  id="grant-subject"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  placeholder="the human this connection authorizes for"
                />
              </div>
            )
            : null}

          <div className="space-y-1.5">
            <Label htmlFor="grant-alias">Alias</Label>
            <Input
              id="grant-alias"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder="mail"
            />
            <p className="text-muted-foreground text-xs">
              What the client calls this connection. Lowercase letters, digits and
              dashes. The same alias means something different in each deployment,
              which is the point.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Decision</Label>
            <Select
              value={decision}
              onValueChange={(value) => setDecision(decodeGrantDecision(value))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">Allow — call straight through</SelectItem>
                <SelectItem value="require_approval">
                  Ask a human — freeze the call for approval
                </SelectItem>
              </SelectContent>
            </Select>
            {tool === undefined ? null : (
              <p className="text-muted-foreground text-xs">
                Suggested default: {decisionLabel[tool.defaultDecision].toLowerCase()}.
                You can override it for this client.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={tool === undefined || !aliasIsValid || create.isPending ||
              (needsSubject && subject.trim().length === 0)}
          >
            {create.isPending ? "Granting…" : "Grant"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function GrantRow({ grant, clientId }: { readonly grant: Grant; readonly clientId: string }) {
  const invalidate = useInvalidate()

  const revoke = useMutation({
    mutationFn: () => gateway.revokeGrant(grant.id),
    onSuccess: () => {
      invalidate(keys.grants(clientId))
      toast.success("Revoked")
    },
    onError: (error: Error) => toast.error("Could not revoke", { description: error.message })
  })

  // A grant's decision is immutable by design — the gateway has no update
  // route, and an audit trail of "this was allowed at the time" depends on
  // that. Changing it is therefore a revoke and a fresh grant, which is what
  // the audit log will show.
  const change = useMutation({
    mutationFn: async (next: GrantDecision) => {
      await gateway.revokeGrant(grant.id)
      return await gateway.createGrant({
        clientId,
        alias: grant.alias,
        tool: grant.tool,
        connection: grant.connection,
        decision: next
      })
    },
    onSuccess: (next) => {
      invalidate(keys.grants(clientId))
      toast.success(`Now ${decisionLabel[next.decision].toLowerCase()}`)
    },
    onError: (error: Error) => {
      invalidate(keys.grants(clientId))
      toast.error("Could not change the decision", {
        description: `${error.message} — the old grant may already be revoked; check the list.`
      })
    }
  })

  return (
    <TableRow>
      <TableCell>
        <code className="font-mono text-sm">{grant.alias}</code>
      </TableCell>
      <TableCell className="font-medium">{grant.tool}</TableCell>
      <TableCell className="text-muted-foreground font-mono text-xs">
        {connectionLabel(grant.connection)}
      </TableCell>
      <TableCell>
        <Select
          value={grant.decision}
          onValueChange={(value) => change.mutate(decodeGrantDecision(value))}
          disabled={change.isPending}
        >
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="allow">Allow</SelectItem>
            <SelectItem value="require_approval">Ask a human</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">{when(grant.createdAt)}</TableCell>
      <TableCell className="text-right">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" disabled={revoke.isPending}>
              <Trash2 className="size-3" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke {grant.alias}.{grant.tool}?</AlertDialogTitle>
              <AlertDialogDescription>
                The client stops being able to call it, and stops being able to
                see that it exists.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => revoke.mutate()}>Revoke</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  )
}

