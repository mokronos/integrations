import { ArrowLeft } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import { ClientKeys } from "@/components/clients/client-keys"
import { ClientMcp } from "@/components/clients/client-mcp"
import { ClientSettings } from "@/components/clients/client-settings"
import { RevokeClientButton } from "@/components/clients/revoke-client-button"
import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EditableTitle } from "@/components/ui/editable-title"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ResourceSelect } from "@/components/clients/resource-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import * as gateway from "@/lib/gateway"
import { connectionLabel } from "@/lib/format"
import { keys, refetchAll, useAccessProfiles, useApiKeys, useApprovalPolicies, useClients, useClientTools, useInvalidate, useMutation } from "@/lib/queries"
import type { EffectiveTool } from "@/lib/schemas"

export function ClientDetailRoute() {
  const { clientId } = useParams()
  const clients = useClients()
  const profiles = useAccessProfiles()
  const policies = useApprovalPolicies()
  const tools = useClientTools(clientId)
  const apiKeys = useApiKeys(clientId ?? "")
  const invalidate = useInvalidate()
  const navigate = useNavigate()
  const client = clients.data?.find((item) => item.id === clientId)
  const rename = useMutation({ mutationFn: (name: string) => gateway.renameClient(clientId ?? "", name), onSuccess: (renamed) => { invalidate(keys.clients); toast.success(`Now called ${renamed.name}`) }, onError: (error: Error) => toast.error("Could not rename client", { description: error.message }) })
  const assignProfile = useMutation({ mutationFn: (id: string) => gateway.assignAccessProfile(clientId ?? "", id), onSuccess: () => { invalidate(keys.clients, keys.accessProfiles, keys.clientTools(clientId ?? "")); toast.success("Access profile assigned") } })
  const assignPolicy = useMutation({ mutationFn: (id: string) => gateway.assignApprovalPolicy(clientId ?? "", id), onSuccess: () => { invalidate(keys.clients, keys.approvalPolicies, keys.clientTools(clientId ?? "")); toast.success("Approval policy assigned") } })
  if (clientId === undefined) return null
  const liveKeys = (apiKeys.data ?? []).filter((entry) => entry.revokedAt === null).length
  const revoked = client !== undefined && client.revokedAt !== null
  const toolList = tools.data ?? []
  const approvalCount = toolList.filter((tool) => tool.decision !== "allow").length

  return (
    <Page
      title={client === undefined ? "Client" : <><EditableTitle value={client.name} onSave={(name) => rename.mutate(name)} saving={rename.isPending} disabled={revoked} />{revoked ? <Badge variant="outline">revoked</Badge> : null}</>}
      description="Credentials and reusable access and approval assignments."
      actions={<>
        {client === undefined || revoked ? null : <RevokeClientButton clientId={clientId} clientName={client.name} onRevoked={() => void navigate("/clients")} />}
        <ReloadButton onClick={() => refetchAll(clients, tools, apiKeys)} />
      </>}
    >
      <Button variant="ghost" size="sm" className="w-fit" render={<Link to="/clients" />}><ArrowLeft className="size-3" />All clients</Button>
      <QueryError error={clients.error ?? profiles.error ?? policies.error ?? tools.error ?? apiKeys.error} />
      {client === undefined ? <LoadingRows /> : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <ClientMcp clientId={clientId} clientName={client.name} disabled={client.revokedAt !== null} />
            </div>
            <Card>
              <CardHeader>
                <CardTitle>Access</CardTitle>
                <CardDescription>
                  {tools.isPending ? "Resolving effective tools…" : `${toolList.length} ${toolList.length === 1 ? "tool" : "tools"} enabled, ${approvalCount} need approval.`}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <ResourceSelect label="Access profile" value={client.accessProfileId} resources={(profiles.data ?? []).map((item) => item.accessProfile)} onChange={(id) => assignProfile.mutate(id)} />
                <ResourceSelect label="Approval policy" value={client.approvalPolicyId} resources={(policies.data ?? []).map((item) => item.approvalPolicy)} onChange={(id) => assignPolicy.mutate(id)} />
              </CardContent>
            </Card>
          </div>
          <Tabs defaultValue="tools">
            <TabsList>
              <TabsTrigger value="tools">Effective tools <Badge variant="secondary">{toolList.length}</Badge></TabsTrigger>
              <TabsTrigger value="keys">API keys <Badge variant="secondary">{liveKeys}</Badge></TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
            <TabsContent value="tools">
              {tools.isPending ? <LoadingRows /> : <EffectiveTools tools={toolList} />}
            </TabsContent>
            <TabsContent value="keys">
              <ClientKeys clientId={clientId} clientName={client.name} disabled={client.revokedAt !== null} />
            </TabsContent>
            <TabsContent value="settings">
              <ClientSettings client={client} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </Page>
  )
}


function EffectiveTools({ tools }: { readonly tools: ReadonlyArray<EffectiveTool> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Effective tools</CardTitle>
        <CardDescription>The intersection of the assigned access profile and approval policy. This is exactly what an MCP client sees.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Connection</TableHead><TableHead>Tool</TableHead><TableHead>Decision</TableHead></TableRow></TableHeader>
          <TableBody>
            {tools.length === 0
              ? <TableRow><TableCell colSpan={3} className="text-muted-foreground py-8 text-center">No tools enabled for this client.</TableCell></TableRow>
              : tools.map((tool) => (
                <TableRow key={`${tool.alias}:${tool.tool}`}>
                  <TableCell><span className="block font-mono">{connectionLabel(tool.connection)}</span><span className="text-muted-foreground block font-mono text-xs">{tool.alias}</span></TableCell>
                  <TableCell>{tool.tool}</TableCell>
                  <TableCell><Badge>{tool.decision === "allow" ? "allow" : "approval required"}</Badge></TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
