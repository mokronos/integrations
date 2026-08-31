import { ArrowLeft, ExternalLink, ShieldAlert } from "lucide-react"
import { useState } from "react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"

import { ClientConnections } from "@/components/clients/client-connections"
import { ClientKeys } from "@/components/clients/client-keys"
import { ClientSettings } from "@/components/clients/client-settings"
import { ClonePolicyDialog } from "@/components/policies/policy-dialogs"
import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { when } from "@/lib/format"
import * as gateway from "@/lib/gateway"
import { keys, useClients, useClientTools, useInvalidate, useMutation, usePolicies } from "@/lib/queries"
import { decodePolicyId } from "@/lib/schemas"
import type { Client, PolicySummary } from "@/lib/schemas"

function AssignedPolicyCard({
  client,
  policies
}: {
  readonly client: Client
  readonly policies: ReadonlyArray<PolicySummary>
}) {
  const invalidate = useInvalidate()
  const [policyId, setPolicyId] = useState<string>(client.policyId)
  const assigned = policies.find((summary) => summary.policy.id === client.policyId)
  const assign = useMutation({
    mutationFn: () => gateway.assignPolicy({ clientId: client.id, policyId: decodePolicyId(policyId) }),
    onSuccess: (updated) => {
      invalidate(keys.clients, keys.policies, keys.clientTools(client.id), keys.overview)
      toast.success(`${updated.name} now uses the selected policy`)
    },
    onError: (error: Error) => toast.error("Could not change policy", { description: error.message })
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Assigned policy</CardTitle>
          {assigned?.policy.isDefault === true ? <Badge>default</Badge> : null}
          {assigned === undefined ? <Badge variant="destructive">unavailable</Badge> : null}
        </div>
        <CardDescription>
          {assigned === undefined
            ? `Policy ${client.policyId} is assigned but could not be loaded.`
            : `${assigned.policy.name} governs ${assigned.connectionCount} connections and ${assigned.enabledToolCount} enabled tools, and is shared by ${assigned.assignedClientCount} clients. It only takes effect on the connections granted below.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Select value={policyId} onValueChange={setPolicyId} disabled={client.revokedAt !== null}>
          <SelectTrigger className="w-full sm:max-w-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {policies.map((summary) => (
              <SelectItem key={summary.policy.id} value={summary.policy.id}>
                {summary.policy.name}{summary.policy.isDefault ? " (default)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {assigned === undefined ? null : (
          <ClonePolicyDialog policyId={assigned.policy.id} policyName={assigned.policy.name} clientId={client.id} />
        )}
        <Button
          variant="outline"
          onClick={() => assign.mutate()}
          disabled={client.revokedAt !== null || policyId === client.policyId || assign.isPending}
        >
          {assign.isPending ? "Assigning…" : "Change assigned policy"}
        </Button>
        {assigned === undefined ? null : (
          <Button variant="ghost" asChild>
            <Link to={`/policies/${assigned.policy.id}`}>Edit shared policy<ExternalLink className="size-4" /></Link>
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

export function ClientDetailRoute() {
  const { clientId } = useParams()
  const clients = useClients()
  const policies = usePolicies()
  const tools = useClientTools(clientId)
  const client = (clients.data ?? []).find((candidate) => candidate.id === clientId)

  if (clientId === undefined) return null

  return (
    <Page
      title={client?.name ?? "Client"}
      description="Its credentials, control-plane authority, assigned policy, and effective tool access."
      actions={<ReloadButton onClick={() => { void clients.refetch(); void policies.refetch(); void tools.refetch() }} busy={clients.isFetching || policies.isFetching || tools.isFetching} />}
    >
      <Button variant="ghost" size="sm" className="w-fit" asChild>
        <Link to="/clients"><ArrowLeft className="size-3" />All clients</Link>
      </Button>

      <QueryError error={tools.error ?? policies.error ?? clients.error} />

      {client === undefined ? clients.isPending ? <LoadingRows /> : null : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <code className="font-mono text-sm">{client.id}</code>
                {client.capabilities.includes("administer_gateway") ? (
                  <Badge variant="destructive" className="gap-1"><ShieldAlert className="size-3" />administrator</Badge>
                ) : <Badge variant="secondary">client</Badge>}
                {client.revokedAt === null ? null : <Badge variant="outline">revoked {when(client.revokedAt)}</Badge>}
              </CardTitle>
            </CardHeader>
            {client.capabilities.includes("administer_gateway") ? (
              <CardContent className="text-muted-foreground text-sm">
                This client can administer clients, keys, policies, approvals, and audit. Tool invocation still resolves through the intersection of its assigned policy and the connections it has been granted.
              </CardContent>
            ) : null}
          </Card>
          <AssignedPolicyCard
            key={`${client.id}:${client.policyId}`}
            client={client}
            policies={policies.data ?? []}
          />
          <ClientConnections clientId={clientId} disabled={client.revokedAt !== null} />
          <ClientSettings key={`${client.id}:${client.capabilities.join(",")}:${JSON.stringify(client.approvalDelivery)}`} client={client} />
          <ClientKeys clientId={clientId} disabled={client.revokedAt !== null} />
        </>
      )}

      {tools.isPending ? <LoadingRows /> : (
        <Card>
          <CardHeader>
            <CardTitle>Effective tool access</CardTitle>
            <CardDescription>What this client can call: the connections it holds, crossed with what its policy enables on them.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Alias</TableHead>
                <TableHead>Integration</TableHead>
                <TableHead>Connection</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead>Decision</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {(tools.data ?? []).length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-muted-foreground py-10 text-center">No effective tools.</TableCell></TableRow>
                ) : (tools.data ?? []).map((tool) => (
                  <TableRow key={`${tool.alias}:${tool.tool}`}>
                    <TableCell><code className="text-sm">{tool.alias}</code></TableCell>
                    <TableCell>{tool.integration}</TableCell>
                    <TableCell><code className="text-xs">{tool.connection}</code></TableCell>
                    <TableCell className="font-medium">{tool.tool}</TableCell>
                    <TableCell><Badge variant={tool.decision === "allow" ? "secondary" : "default"}>{tool.decision === "allow" ? "allow" : "approval required"}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </Page>
  )
}
