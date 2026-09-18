import { useState } from "react"
import { toast } from "sonner"
import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { RowLink, rowNavigates } from "@/components/ui/row-link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { IssueKeyButton } from "@/components/clients/issue-key-button"
import { RevokeClientButton } from "@/components/clients/revoke-client-button"
import { defaultResourceId, ResourceSelect } from "@/components/clients/resource-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import * as gateway from "@/lib/gateway"
import { when } from "@/lib/format"
import { keys, refetchAll, useAccessProfiles, useApprovalPolicies, useClients, useInvalidate, useMutation } from "@/lib/queries"

function CreateClientDialog() {
  const profiles = useAccessProfiles(); const policies = useApprovalPolicies(); const invalidate = useInvalidate()
  const profileList = (profiles.data ?? []).map((item) => item.accessProfile); const policyList = (policies.data ?? []).map((item) => item.approvalPolicy)
  const [open, setOpen] = useState(false); const [name, setName] = useState(""); const [chosenProfileId, setProfileId] = useState<string | undefined>(); const [chosenPolicyId, setPolicyId] = useState<string | undefined>()
  const profileId = chosenProfileId ?? defaultResourceId(profileList); const policyId = chosenPolicyId ?? defaultResourceId(policyList)
  const create = useMutation({ mutationFn: () => gateway.createClient({ name: name.trim(), accessProfileId: profileId, approvalPolicyId: policyId, capabilities: [], approvalDelivery: { returnLink: true } }), onSuccess: (client) => { invalidate(keys.clients); setOpen(false); toast.success(`Created ${client.name}`) }, onError: (error: Error) => toast.error("Could not create client", { description: error.message }) })
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger render={<Button />}>New client</DialogTrigger><DialogContent><DialogHeader><DialogTitle>New client</DialogTitle><DialogDescription>Assign reusable access and approval configuration.</DialogDescription></DialogHeader><div className="space-y-4"><div><Label htmlFor="client-name">Name</Label><Input id="client-name" value={name} onChange={(event) => setName(event.target.value)} /></div><ResourceSelect label="Access profile" value={profileId} onChange={setProfileId} resources={profileList} /><ResourceSelect label="Approval policy" value={policyId} onChange={setPolicyId} resources={policyList} /></div><DialogFooter><Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Create</Button></DialogFooter></DialogContent></Dialog>
}


export function ClientsRoute() { const clients = useClients(); const profiles = useAccessProfiles(); const policies = useApprovalPolicies(); return <Page title="Clients" description="Callers and their reusable access and approval assignments." actions={<><CreateClientDialog /><ReloadButton onClick={() => refetchAll(clients)} /></>}><QueryError error={clients.error ?? profiles.error ?? policies.error} />{clients.isPending ? <LoadingRows /> : <Card><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead>Client</TableHead><TableHead>Access profile</TableHead><TableHead>Approval policy</TableHead><TableHead>Created</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader><TableBody>{(clients.data ?? []).map((client) => <TableRow key={client.id} className={rowNavigates}><TableCell><RowLink to={`/clients/${client.id}`}>{client.name}</RowLink><div className="text-muted-foreground font-mono text-xs">{client.id}</div></TableCell><TableCell>{profiles.data?.find((item) => item.accessProfile.id === client.accessProfileId)?.accessProfile.name ?? client.accessProfileId}</TableCell><TableCell>{policies.data?.find((item) => item.approvalPolicy.id === client.approvalPolicyId)?.approvalPolicy.name ?? client.approvalPolicyId}</TableCell><TableCell>{when(client.createdAt)}</TableCell><TableCell>{client.revokedAt === null ? <Badge variant="secondary">active</Badge> : <Badge variant="outline">revoked</Badge>}</TableCell><TableCell className="relative z-10 text-right">{client.revokedAt === null ? <span className="inline-flex items-center gap-1"><IssueKeyButton clientId={client.id} clientName={client.name} disabled={false} variant="outline" /><RevokeClientButton clientId={client.id} clientName={client.name} /></span> : null}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>}</Page> }
