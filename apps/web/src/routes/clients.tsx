import { useState } from "react"
import { whenPresent } from "@mokronos/contracts"
import { toast } from "sonner"
import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { RowLink, rowNavigates } from "@/components/ui/row-link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import * as gateway from "@/lib/gateway"
import { when } from "@/lib/format"
import { keys, useAccessProfiles, useApprovalPolicies, useClients, useInvalidate, useMutation } from "@/lib/queries"

function CreateClientDialog() {
  const profiles = useAccessProfiles(); const policies = useApprovalPolicies(); const invalidate = useInvalidate()
  const [open, setOpen] = useState(false); const [name, setName] = useState(""); const [profileId, setProfileId] = useState("__default__"); const [policyId, setPolicyId] = useState("__default__")
  const create = useMutation({ mutationFn: () => gateway.createClient({ name: name.trim(), ...whenPresent("accessProfileId", profileId === "__default__" ? undefined : profileId), ...whenPresent("approvalPolicyId", policyId === "__default__" ? undefined : policyId), capabilities: [], approvalDelivery: { returnLink: true, webhooks: [] } }), onSuccess: (client) => { invalidate(keys.clients); setOpen(false); toast.success(`Created ${client.name}`) }, onError: (error: Error) => toast.error("Could not create client", { description: error.message }) })
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button>New client</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>New client</DialogTitle><DialogDescription>Assign reusable access and approval configuration.</DialogDescription></DialogHeader><div className="space-y-4"><div><Label htmlFor="client-name">Name</Label><Input id="client-name" value={name} onChange={(event) => setName(event.target.value)} /></div><ResourceSelect label="Access profile" value={profileId} onChange={setProfileId} resources={(profiles.data ?? []).map((item) => item.accessProfile)} /><ResourceSelect label="Approval policy" value={policyId} onChange={setPolicyId} resources={(policies.data ?? []).map((item) => item.approvalPolicy)} /></div><DialogFooter><Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Create</Button></DialogFooter></DialogContent></Dialog>
}

export function ResourceSelect({ label, value, onChange, resources }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly resources: ReadonlyArray<{ readonly id: string; readonly name: string; readonly isDefault: boolean }> }) { return <div className="space-y-1.5"><Label>{label}</Label><Select value={value} onValueChange={onChange}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__default__">Gateway default</SelectItem>{resources.filter((resource) => !resource.isDefault).map((resource) => <SelectItem key={resource.id} value={resource.id}>{resource.name}</SelectItem>)}</SelectContent></Select></div> }

export function ClientsRoute() { const clients = useClients(); const profiles = useAccessProfiles(); const policies = useApprovalPolicies(); return <Page title="Clients" description="Callers and their reusable access and approval assignments." actions={<><CreateClientDialog /><ReloadButton onClick={() => void clients.refetch()} busy={clients.isFetching} /></>}><QueryError error={clients.error ?? profiles.error ?? policies.error} />{clients.isPending ? <LoadingRows /> : <Card><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead>Client</TableHead><TableHead>Access profile</TableHead><TableHead>Approval policy</TableHead><TableHead>Created</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{(clients.data ?? []).map((client) => <TableRow key={client.id} className={rowNavigates}><TableCell><RowLink to={`/clients/${client.id}`}>{client.name}</RowLink><div className="text-muted-foreground font-mono text-xs">{client.id}</div></TableCell><TableCell>{profiles.data?.find((item) => item.accessProfile.id === client.accessProfileId)?.accessProfile.name ?? client.accessProfileId}</TableCell><TableCell>{policies.data?.find((item) => item.approvalPolicy.id === client.approvalPolicyId)?.approvalPolicy.name ?? client.approvalPolicyId}</TableCell><TableCell>{when(client.createdAt)}</TableCell><TableCell>{client.revokedAt === null ? <Badge variant="secondary">active</Badge> : <Badge variant="outline">revoked</Badge>}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>}</Page> }
