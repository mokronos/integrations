import { ArrowLeft } from "lucide-react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"
import { ClientKeys } from "@/components/clients/client-keys"
import { ClientSettings } from "@/components/clients/client-settings"
import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import * as gateway from "@/lib/gateway"
import { connectionLabel } from "@/lib/format"
import { keys, useAccessProfiles, useApprovalPolicies, useClients, useClientTools, useInvalidate, useMutation } from "@/lib/queries"

export function ClientDetailRoute() {
  const { clientId } = useParams(); const clients = useClients(); const profiles = useAccessProfiles(); const policies = useApprovalPolicies(); const tools = useClientTools(clientId); const invalidate = useInvalidate(); const client = clients.data?.find((item) => item.id === clientId)
  const assignProfile = useMutation({ mutationFn: (id: string) => gateway.assignAccessProfile(clientId ?? "", id), onSuccess: () => { invalidate(keys.clients, keys.accessProfiles, keys.clientTools(clientId ?? "")); toast.success("Access profile assigned") } })
  const assignPolicy = useMutation({ mutationFn: (id: string) => gateway.assignApprovalPolicy(clientId ?? "", id), onSuccess: () => { invalidate(keys.clients, keys.approvalPolicies, keys.clientTools(clientId ?? "")); toast.success("Approval policy assigned") } })
  if (clientId === undefined) return null
  return <Page title={client?.name ?? "Client"} description="Credentials and reusable access and approval assignments." actions={<ReloadButton onClick={() => { void clients.refetch(); void tools.refetch() }} busy={clients.isFetching || tools.isFetching} />}><Button variant="ghost" size="sm" className="w-fit" asChild><Link to="/clients"><ArrowLeft className="size-3" />All clients</Link></Button><QueryError error={clients.error ?? profiles.error ?? policies.error ?? tools.error} />{client === undefined ? <LoadingRows /> : <><div className="grid gap-4 lg:grid-cols-2"><AssignmentCard title="Access profile" description="Controls which tools and therefore which connections are enabled." value={client.accessProfileId} resources={(profiles.data ?? []).map((item) => item.accessProfile)} onChange={(id) => assignProfile.mutate(id)} /><AssignmentCard title="Approval policy" description="Controls whether enabled tools run immediately or require approval." value={client.approvalPolicyId} resources={(policies.data ?? []).map((item) => item.approvalPolicy)} onChange={(id) => assignPolicy.mutate(id)} /></div><ClientSettings client={client} /><ClientKeys clientId={clientId} disabled={client.revokedAt !== null} /></>}{tools.isPending ? <LoadingRows /> : <Card><CardHeader><CardTitle>Effective tools</CardTitle><CardDescription>The intersection of the assigned access profile and approval policy.</CardDescription></CardHeader><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead>Connection</TableHead><TableHead>Tool</TableHead><TableHead>Decision</TableHead></TableRow></TableHeader><TableBody>{(tools.data ?? []).map((tool) => <TableRow key={`${tool.alias}:${tool.tool}`}><TableCell><span className="block font-mono">{connectionLabel(tool.connection)}</span>{/* The alias is how a caller names this connection on the wire. It is
        derived from the address above, so it belongs under it rather than in a
        column of its own. */}<span className="text-muted-foreground block font-mono text-xs">{tool.alias}</span></TableCell><TableCell>{tool.tool}</TableCell><TableCell><Badge>{tool.decision === "allow" ? "allow" : "approval required"}</Badge></TableCell></TableRow>)}</TableBody></Table></CardContent></Card>}</Page>
}

function AssignmentCard({ title, description, value, resources, onChange }: { readonly title: string; readonly description: string; readonly value: string; readonly resources: ReadonlyArray<{ readonly id: string; readonly name: string; readonly isDefault: boolean }>; readonly onChange: (id: string) => void }) { return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent><Select value={value} onValueChange={onChange}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{resources.map((resource) => <SelectItem key={resource.id} value={resource.id}>{resource.name}{resource.isDefault ? " (default)" : ""}</SelectItem>)}</SelectContent></Select></CardContent></Card> }
