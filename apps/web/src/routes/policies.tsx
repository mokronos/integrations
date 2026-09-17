import { ArrowLeft } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import { ConfigurationDialog } from "@/components/policies/policy-dialogs"
import { AccessProfileEditor, ApprovalPolicyEditor } from "@/components/policies/policy-editor"
import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmButton } from "@/components/ui/confirm-button"
import { EditableTitle } from "@/components/ui/editable-title"
import { RowLink, rowNavigates } from "@/components/ui/row-link"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { when } from "@/lib/format"
import * as gateway from "@/lib/gateway"
import { keys, useAccessProfile, useAccessProfiles, useApprovalPolicies, useApprovalPolicy, useInvalidate, useMutation } from "@/lib/queries"

type ConfigurationKind = "access-profile" | "approval-policy"
type ConfigurationResource = { readonly id: string; readonly name: string; readonly isDefault: boolean }
const kindLabel = (kind: ConfigurationKind) => kind === "access-profile" ? "access profile" : "approval policy"
const kindPath = (kind: ConfigurationKind) => kind === "access-profile" ? "/access-profiles" : "/approval-policies"
const kindKeys = (kind: ConfigurationKind, id: string) => kind === "access-profile" ? [keys.accessProfiles, keys.accessProfile(id)] : [keys.approvalPolicies, keys.approvalPolicy(id)]

export function AccessProfilesRoute() { const query = useAccessProfiles(); return <ConfigurationList kind="access-profile" query={query} /> }
export function ApprovalPoliciesRoute() { const query = useApprovalPolicies(); return <ConfigurationList kind="approval-policy" query={query} /> }

function ConfigurationList({ kind, query }: { readonly kind: ConfigurationKind; readonly query: ReturnType<typeof useAccessProfiles> | ReturnType<typeof useApprovalPolicies> }) {
  const access = kind === "access-profile"
  const rows = query.data ?? []
  return <Page title={access ? "Access profiles" : "Approval policies"} description={access ? "Reusable sets of enabled tools and connections." : "Reusable allow and approval requirements for connected tools."} actions={<><ConfigurationDialog kind={kind} /><ReloadButton onClick={() => void query.refetch()} busy={query.isFetching} /></>}><QueryError error={query.error} />{query.isPending ? <LoadingRows /> : <Card><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Connections</TableHead><TableHead>Tools</TableHead><TableHead>Clients</TableHead><TableHead>Updated</TableHead><TableHead /></TableRow></TableHeader><TableBody>{rows.map((summary) => { const resource = "accessProfile" in summary ? summary.accessProfile : summary.approvalPolicy; return <TableRow key={resource.id} className={rowNavigates}><TableCell><RowLink to={`/${access ? "access-profiles" : "approval-policies"}/${resource.id}`}>{resource.name}</RowLink>{resource.isDefault ? <Badge className="ml-2">default</Badge> : null}</TableCell><TableCell>{summary.connectionCount}</TableCell><TableCell>{summary.toolCount}</TableCell><TableCell>{summary.assignedClientCount}</TableCell><TableCell>{when(resource.updatedAt)}</TableCell><TableCell className="relative z-10 text-right"><span className="inline-flex items-center gap-1"><ConfigurationDialog kind={kind} source={{ id: resource.id, name: resource.name }} />{resource.isDefault ? null : <DeleteConfiguration kind={kind} resource={resource} assignedClientCount={summary.assignedClientCount} />}</span></TableCell></TableRow>})}</TableBody></Table></CardContent></Card>}</Page>
}

export function AccessProfileDetailRoute() { const { accessProfileId } = useParams(); const query = useAccessProfile(accessProfileId); const resource = query.data?.accessProfile; return <ConfigurationDetail kind="access-profile" query={query} resource={resource}>{resource === undefined ? null : <AccessProfileEditor key={resource.updatedAt.toISOString()} id={resource.id} storedTools={query.data?.tools ?? []} assignedClientCount={query.data?.assignedClients.length ?? 0} />}</ConfigurationDetail> }
export function ApprovalPolicyDetailRoute() { const { approvalPolicyId } = useParams(); const query = useApprovalPolicy(approvalPolicyId); const resource = query.data?.approvalPolicy; return <ConfigurationDetail kind="approval-policy" query={query} resource={resource}>{resource === undefined ? null : <ApprovalPolicyEditor key={resource.updatedAt.toISOString()} id={resource.id} storedTools={query.data?.tools ?? []} assignedClientCount={query.data?.assignedClients.length ?? 0} />}</ConfigurationDetail> }

function ConfigurationDetail({ kind, query, resource, children }: { readonly kind: ConfigurationKind; readonly query: ReturnType<typeof useAccessProfile> | ReturnType<typeof useApprovalPolicy>; readonly resource: ConfigurationResource | undefined; readonly children: React.ReactNode }) {
  const invalidate = useInvalidate()
  const label = kindLabel(kind)
  const title = label.charAt(0).toUpperCase() + label.slice(1)
  const assignedClientCount = query.data?.assignedClients.length ?? 0
  const rename = useMutation({
    mutationFn: async (name: string): Promise<ConfigurationResource> => kind === "access-profile" ? gateway.renameAccessProfile(resource?.id ?? "", name) : gateway.renameApprovalPolicy(resource?.id ?? "", name),
    onSuccess: (renamed) => { invalidate(...kindKeys(kind, renamed.id), keys.clients, keys.overview); toast.success(`Now called ${renamed.name}`) },
    onError: (error: Error) => toast.error(`Could not rename ${label}`, { description: error.message })
  })
  return <Page
    title={resource === undefined ? title : <><EditableTitle value={resource.name} onSave={(name) => rename.mutate(name)} saving={rename.isPending} />{resource.isDefault ? <Badge>default</Badge> : null}</>}
    description={`Edit this reusable ${label}.`}
    actions={<>{resource === undefined || resource.isDefault ? null : <DeleteConfiguration kind={kind} resource={resource} assignedClientCount={assignedClientCount} />}<ReloadButton onClick={() => void query.refetch()} busy={query.isFetching} /></>}
  >
    <Button variant="ghost" size="sm" className="w-fit" render={<Link to={kindPath(kind)} />}><ArrowLeft className="size-3" />All {label}s</Button>
    <QueryError error={query.error} />
    {query.isPending ? <LoadingRows /> : children}
  </Page>
}

function DeleteConfiguration({ kind, resource, assignedClientCount }: { readonly kind: ConfigurationKind; readonly resource: ConfigurationResource; readonly assignedClientCount: number }) {
  const invalidate = useInvalidate()
  const navigate = useNavigate()
  const label = kindLabel(kind)
  const remove = useMutation({
    mutationFn: () => kind === "access-profile" ? gateway.deleteAccessProfile(resource.id) : gateway.deleteApprovalPolicy(resource.id),
    onSuccess: () => { invalidate(...kindKeys(kind, resource.id), keys.overview); toast.success(`${resource.name} deleted`); void navigate(kindPath(kind)) },
    onError: (error: Error) => toast.error(`Could not delete ${label}`, { description: error.message })
  })
  const blocked = assignedClientCount > 0
  return <ConfirmButton
    label="Delete"
    title={`Delete ${resource.name}?`}
    description={blocked
      ? `${assignedClientCount} client${assignedClientCount === 1 ? " is" : "s are"} still assigned to this ${label}. Reassign them before deleting it.`
      : `The ${label} and its tool rules are removed. Clients cannot be assigned to it afterwards.`}
    confirmLabel="Delete"
    pendingLabel="Deleting…"
    pending={remove.isPending}
    blocked={blocked}
    onConfirm={() => remove.mutateAsync().then(() => undefined)}
  />
}
