import { useMemo, useState } from "react"
import { Link, useParams } from "react-router"
import { ArrowLeft, Code2, Copy, KeyRound, ShieldAlert, Trash2 } from "lucide-react"
import { generateTypeScriptModule } from "@mokronos/integrations-client/codegen"
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { connectionLabel, when } from "@/lib/format"
import * as gateway from "@/lib/gateway"
import {
  keys,
  useClients,
  useGrants,
  useIntegrations,
  useInvalidate,
  useMutation,
  useQuery
} from "@/lib/queries"
import type { ConnectionRefInput } from "@/lib/gateway"
import { decodeGrantDecision } from "@/lib/schemas"
import type { ApiKeySummary, Client, Grant, GrantDecision } from "@/lib/schemas"

const decisionLabel = {
  allow: "Allow",
  require_approval: "Ask a human"
} satisfies Readonly<Record<GrantDecision, string>>

function CodegenDialog({ clientId }: { readonly clientId: string }) {
  const [open, setOpen] = useState(false)
  const [module, setModule] = useState<string | undefined>()

  const generate = useMutation({
    mutationFn: async () => {
      const tools = await gateway.listClientTools(clientId, true)
      if (tools.length === 0) throw new Error("Grant at least one tool before generating bindings")
      return generateTypeScriptModule(tools, window.location.origin)
    },
    onSuccess: setModule,
    onError: (error: Error) => toast.error("Could not generate bindings", { description: error.message })
  })

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setModule(undefined) }}>
      <DialogTrigger asChild>
        <Button variant="outline"><Code2 className="size-4" /> Generate bindings</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Generate authorized bindings</DialogTitle>
          <DialogDescription>
            The generated module contains exactly this client’s active grants, including current input and output schemas.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Button onClick={() => generate.mutate()} disabled={generate.isPending}>
            {generate.isPending ? "Generating…" : "Generate"}
          </Button>
        </div>
        {module === undefined ? null : (
          <pre className="bg-muted/60 max-h-[32rem] overflow-auto rounded-lg p-4 font-mono text-xs leading-relaxed">{module}</pre>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={module === undefined}
            onClick={() => {
              void navigator.clipboard.writeText(module ?? "")
              toast.success("Bindings copied")
            }}
          >
            <Copy className="size-4" /> Copy module
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function KeyRow({ keySummary, clientId }: {
  readonly keySummary: ApiKeySummary
  readonly clientId: string
}) {
  const invalidate = useInvalidate()
  const revoke = useMutation({
    mutationFn: () => gateway.revokeKey(keySummary.id),
    onSuccess: () => {
      invalidate(["keys", clientId])
      toast.success("API key revoked")
    },
    onError: (error: Error) => toast.error("Could not revoke key", { description: error.message })
  })
  const revoked = keySummary.revokedAt !== null

  return (
    <TableRow className={revoked ? "opacity-55" : undefined}>
      <TableCell className="font-mono text-xs">{keySummary.id}</TableCell>
      <TableCell className="text-muted-foreground text-sm">{when(keySummary.createdAt)}</TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {keySummary.lastUsedAt === null ? "Never" : when(keySummary.lastUsedAt)}
      </TableCell>
      <TableCell>{revoked ? <Badge variant="outline">revoked {when(keySummary.revokedAt)}</Badge> : <Badge variant="secondary">live</Badge>}</TableCell>
      <TableCell className="text-right">
        <Button variant="ghost" size="sm" disabled={revoked || revoke.isPending} onClick={() => revoke.mutate()}>
          Revoke
        </Button>
      </TableCell>
    </TableRow>
  )
}

function ClientKeys({ clientId, disabled }: { readonly clientId: string; readonly disabled: boolean }) {
  const invalidate = useInvalidate()
  const [secret, setSecret] = useState<string | undefined>()
  const keysQuery = useQuery({
    queryKey: ["keys", clientId],
    queryFn: () => gateway.listKeys(clientId)
  })
  const issue = useMutation({
    mutationFn: () => gateway.issueKey(clientId),
    onSuccess: (issued) => {
      setSecret(issued.secret)
      invalidate(["keys", clientId])
    },
    onError: (error: Error) => toast.error("Could not issue key", { description: error.message })
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" /> API keys</CardTitle>
        <CardDescription>Rotate one credential without revoking the whole client.</CardDescription>
        <CardAction>
          <Button size="sm" onClick={() => issue.mutate()} disabled={disabled || issue.isPending}>Issue key</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Key ID</TableHead><TableHead>Created</TableHead><TableHead>Last used</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {(keysQuery.data ?? []).length === 0
              ? <TableRow><TableCell colSpan={5} className="text-muted-foreground py-8 text-center">No keys issued.</TableCell></TableRow>
              : (keysQuery.data ?? []).map((entry) => <KeyRow key={entry.id} keySummary={entry} clientId={clientId} />)}
          </TableBody>
        </Table>
      </CardContent>
      <Dialog open={secret !== undefined} onOpenChange={(next) => next ? undefined : setSecret(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy this key now</DialogTitle>
            <DialogDescription>The gateway stores only its hash. The plaintext cannot be shown again.</DialogDescription>
          </DialogHeader>
          <code className="bg-muted block break-all rounded-md p-3 font-mono text-sm">{secret}</code>
          <DialogFooter>
            <Button onClick={() => { void navigator.clipboard.writeText(secret ?? ""); toast.success("Copied") }}>
              <Copy className="size-4" /> Copy key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

const webhookLines = (source: string): ReadonlyArray<string> =>
  source.split("\n").map((value) => value.trim()).filter((value) => value.length > 0)

function ClientSettings({ client }: { readonly client: Client }) {
  const invalidate = useInvalidate()
  const [mayProvision, setMayProvision] = useState(
    client.capabilities.includes("provision_connections")
  )
  const [mayAdminister, setMayAdminister] = useState(
    client.capabilities.includes("administer_gateway")
  )
  const [returnLink, setReturnLink] = useState(client.approvalDelivery.returnLink)
  const [webhooks, setWebhooks] = useState(client.approvalDelivery.webhooks.join("\n"))
  const parsedWebhooks = webhookLines(webhooks)
  const validWebhooks = parsedWebhooks.length <= 10 &&
    parsedWebhooks.every((url) => /^https?:\/\/[^\s]+$/.test(url))

  const save = useMutation({
    mutationFn: () => {
      const capabilities: Array<"provision_connections" | "administer_gateway"> = []
      if (mayProvision) capabilities.push("provision_connections")
      if (mayAdminister) capabilities.push("administer_gateway")
      return gateway.updateClientSettings({
        clientId: client.id,
        capabilities,
        approvalDelivery: { returnLink, webhooks: parsedWebhooks }
      })
    },
    onSuccess: () => {
      invalidate(keys.clients)
      toast.success("Client settings saved")
    },
    onError: (error: Error) => toast.error("Could not save client settings", {
      description: error.message
    })
  })

  const disabled = client.revokedAt !== null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Authority and approval delivery</CardTitle>
        <CardDescription>
          Tool access comes from grants below. These switches control the wider
          control-plane actions this credential may perform.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch
              id="settings-provision"
              checked={mayProvision}
              onCheckedChange={setMayProvision}
              disabled={disabled}
            />
            <div className="space-y-1">
              <Label htmlFor="settings-provision">Provision connections</Label>
              <p className="text-muted-foreground text-xs">Discover integrations and create or remove connections.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch
              id="settings-administer"
              checked={mayAdminister}
              onCheckedChange={setMayAdminister}
              disabled={disabled}
            />
            <div className="space-y-1">
              <Label htmlFor="settings-administer">Administer gateway</Label>
              <p className="text-muted-foreground text-xs">Manage clients, grants, approvals, policy, and audit data.</p>
            </div>
          </div>
        </div>
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-start gap-3">
            <Switch
              id="settings-return-link"
              checked={returnLink}
              onCheckedChange={setReturnLink}
              disabled={disabled}
            />
            <div className="space-y-1">
              <Label htmlFor="settings-return-link">Return approval link</Label>
              <p className="text-muted-foreground text-xs">Include a signed-in dashboard destination in pending outcomes.</p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-webhooks">Notification webhooks</Label>
            <Textarea
              id="settings-webhooks"
              value={webhooks}
              onChange={(event) => setWebhooks(event.target.value)}
              disabled={disabled}
              placeholder="https://automation.example/hooks/approvals"
            />
            <p className={validWebhooks ? "text-muted-foreground text-xs" : "text-destructive text-xs"}>
              One HTTP(S) URL per line, up to 10. Payloads omit call arguments and credentials.
            </p>
          </div>
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={() => save.mutate()} disabled={disabled || !validWebhooks || save.isPending}>
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </CardFooter>
    </Card>
  )
}

/** Grants are per tool, never per pattern: a vendor shipping a new tool must not
 *  land inside an existing grant. That is why this dialog makes you pick one. */
function GrantDialog({ clientId }: { readonly clientId: string }) {
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

function GrantRow({ grant, clientId }: { readonly grant: Grant; readonly clientId: string }) {
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

export function ClientDetailRoute() {
  const { clientId } = useParams()
  const clients = useClients()
  const grants = useGrants(clientId)

  const client = useMemo(
    () => (clients.data ?? []).find((candidate) => candidate.id === clientId),
    [clients.data, clientId]
  )

  if (clientId === undefined) return null

  return (
    <Page
      title={client?.name ?? "Client"}
      description="Everything this client may reach. Nothing else is visible to it."
      actions={
        <>
          <CodegenDialog clientId={clientId} />
          <GrantDialog clientId={clientId} />
          <ReloadButton onClick={() => void grants.refetch()} busy={grants.isFetching} />
        </>
      }
    >
      <Button variant="ghost" size="sm" className="w-fit" asChild>
        <Link to="/clients">
          <ArrowLeft className="size-3" />
          All clients
        </Link>
      </Button>

      <QueryError error={grants.error ?? clients.error} />

      {client === undefined ? null : (
        <>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <code className="font-mono text-sm">{client.id}</code>
              {client.capabilities.includes("administer_gateway")
                ? (
                  <Badge variant="destructive" className="gap-1">
                    <ShieldAlert className="size-3" />
                    administrator
                  </Badge>
                )
                : <Badge variant="secondary">client</Badge>}
              {client.revokedAt === null
                ? null
                : <Badge variant="outline">revoked {when(client.revokedAt)}</Badge>}
            </CardTitle>
          </CardHeader>
          {client.capabilities.includes("administer_gateway")
            ? (
              <CardContent className="text-muted-foreground text-sm">
                This client can administer clients, keys, grants, audit, and
                gateway policy. Tool invocation still resolves through grants.
              </CardContent>
            )
            : null}
        </Card>
        <ClientSettings key={`${client.id}:${client.capabilities.join(",")}:${JSON.stringify(client.approvalDelivery)}`} client={client} />
        <ClientKeys clientId={clientId} disabled={client.revokedAt !== null} />
        </>
      )}

      {grants.isPending
        ? <LoadingRows />
        : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Alias</TableHead>
                    <TableHead>Tool</TableHead>
                    <TableHead>Connection</TableHead>
                    <TableHead>Decision</TableHead>
                    <TableHead>Granted</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(grants.data ?? []).length === 0
                    ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-muted-foreground py-10 text-center">
                          No grants. This client can see nothing.
                        </TableCell>
                      </TableRow>
                    )
                    : (grants.data ?? []).map((grant) => (
                      <GrantRow key={grant.id} grant={grant} clientId={clientId} />
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
    </Page>
  )
}
