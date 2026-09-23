import { ArrowLeft } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import { ClientKeys } from "@/components/clients/client-keys"
import { ClientMcp } from "@/components/clients/client-mcp"
import { ClientSettings } from "@/components/clients/client-settings"
import { RevokeClientButton } from "@/components/clients/revoke-client-button"
import { IntegrationHeading, useIntegrationCollapse } from "@/components/integrations/integration-heading"
import { ConnectionIdentity } from "@/components/integrations/connection-identity"
import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EditableTitle } from "@/components/ui/editable-title"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ResourceSelect } from "@/components/clients/resource-select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import * as gateway from "@/lib/gateway"
import { connectionLabel } from "@/lib/format"
import { cn } from "@/lib/utils"
import { keys, refetchAll, useAccessProfiles, useApiKeys, useApprovalPolicies, useClients, useClientTools, useIntegrations, useInvalidate, useMutation } from "@/lib/queries"
import type { EffectiveTool, IntegrationOverview } from "@/lib/schemas"

export function ClientDetailRoute() {
  const { clientId } = useParams()
  const clients = useClients()
  const profiles = useAccessProfiles()
  const policies = useApprovalPolicies()
  const tools = useClientTools(clientId)
  const integrations = useIntegrations()
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
      <QueryError error={clients.error ?? profiles.error ?? policies.error ?? tools.error ?? integrations.error ?? apiKeys.error} />
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
                  {tools.isPending ? "Resolving tools…" : `${toolList.length} ${toolList.length === 1 ? "tool" : "tools"} enabled, ${approvalCount} need approval.`}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <ResourceSelect label="Access profile" value={client.accessProfileId} resources={(profiles.data ?? []).map((item) => item.accessProfile)} onChange={(id) => assignProfile.mutate(id)} />
                <ResourceSelect label="Approval policy" value={client.approvalPolicyId} resources={(policies.data ?? []).map((item) => item.approvalPolicy)} onChange={(id) => assignPolicy.mutate(id)} />
              </CardContent>
            </Card>
          </div>
          <Tabs defaultValue="tools">
            <TabsList className="w-full max-w-full">
              <TabsTrigger value="tools" className="min-w-0 text-xs sm:text-sm">Tools <Badge variant="secondary" className="hidden sm:inline-flex">{toolList.length}</Badge></TabsTrigger>
              <TabsTrigger value="keys" className="min-w-0 text-xs sm:text-sm">API keys <Badge variant="secondary" className="hidden sm:inline-flex">{liveKeys}</Badge></TabsTrigger>
              <TabsTrigger value="settings" className="min-w-0 text-xs sm:text-sm">Settings</TabsTrigger>
            </TabsList>
            <TabsContent value="tools">
              {tools.isPending || integrations.isPending
                ? <EffectiveToolsSkeleton />
                : <EffectiveTools tools={toolList} integrations={integrations.data ?? []} />}
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


function EffectiveToolsSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="space-y-2"><Skeleton className="h-5 w-36" /><Skeleton className="h-4 w-2/3" /></div>
      {Array.from({ length: 2 }, (_, index) => (
        <Card key={index} className="py-0">
          <div className="flex items-center gap-3 border-b p-4"><Skeleton className="size-10" /><Skeleton className="h-5 w-36" /></div>
          <div className="space-y-3 p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
        </Card>
      ))}
    </div>
  )
}

function EffectiveTools({ tools, integrations }: {
  readonly tools: ReadonlyArray<EffectiveTool>
  readonly integrations: ReadonlyArray<IntegrationOverview>
}) {
  const grouped = Map.groupBy(tools, (tool) => tool.connection.integration)
  const bySlug = new Map(integrations.map((integration) => [integration.slug, integration]))
  const groups = [...grouped].sort(([left], [right]) =>
    (bySlug.get(left)?.name ?? left).localeCompare(bySlug.get(right)?.name ?? right)
  )
  const collapse = useIntegrationCollapse(groups.length)

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-medium">Tools</h2>
        <p className="text-muted-foreground text-sm">The intersection of the assigned access profile and approval policy. This is exactly what an MCP client sees.</p>
      </div>
      {groups.length === 0
        ? <Card><CardContent className="text-muted-foreground py-8 text-center">No tools enabled for this client.</CardContent></Card>
        : groups.map(([slug, entries]) => {
          const integration = bySlug.get(slug)
          const connections = [...Map.groupBy(entries, (tool) => connectionLabel(tool.connection))]
          const open = collapse.isOpen(slug)
          return (
            <Card key={slug} className="py-0">
              <div className={cn("p-4", open && "border-b")}><IntegrationHeading slug={slug} integration={integration} toolCount={entries.length} open={open} onToggle={() => collapse.toggle(slug)} /></div>
              {open ? connections.map(([connection, connectionTools]) => (
                <section key={connection} className="border-b last:border-b-0">
                  <div className="bg-muted/20 px-4 py-2 text-sm">
                    {connectionTools[0] === undefined ? null : <ConnectionIdentity connection={connectionTools[0].connection} integration={integration} showIntegration={false} />}
                  </div>
                  <div className="divide-y">
                    {connectionTools.map((tool) => {
                      const description = integration?.tools.find((entry) => entry.name === tool.tool && entry.connection === tool.connection.name)?.description
                      return <div key={`${tool.alias}:${tool.tool}`} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="break-all font-mono text-sm font-medium">{tool.tool}</p>
                          {description ? <p className="text-muted-foreground line-clamp-1 text-xs">{description}</p> : null}
                        </div>
                        <Badge variant={tool.decision === "allow" ? "secondary" : "outline"}>
                          {tool.decision === "allow" ? "Runs immediately" : "Approval required"}
                        </Badge>
                      </div>
                    })}
                  </div>
                </section>
              )) : null}
            </Card>
          )
        })}
    </div>
  )
}
