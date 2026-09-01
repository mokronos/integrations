import { ArrowLeft } from "lucide-react"
import { Link, useParams } from "react-router"
import { ConfigurationDialog } from "@/components/policies/policy-dialogs"
import { AccessProfileEditor, ApprovalPolicyEditor } from "@/components/policies/policy-editor"
import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { RowLink, rowNavigates } from "@/components/ui/row-link"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { when } from "@/lib/format"
import { useAccessProfile, useAccessProfiles, useApprovalPolicies, useApprovalPolicy } from "@/lib/queries"

export function AccessProfilesRoute() { const query = useAccessProfiles(); return <ConfigurationList kind="access-profile" query={query} /> }
export function ApprovalPoliciesRoute() { const query = useApprovalPolicies(); return <ConfigurationList kind="approval-policy" query={query} /> }

function ConfigurationList({ kind, query }: { readonly kind: "access-profile" | "approval-policy"; readonly query: ReturnType<typeof useAccessProfiles> | ReturnType<typeof useApprovalPolicies> }) {
  const access = kind === "access-profile"
  const rows = query.data ?? []
  return <Page title={access ? "Access profiles" : "Approval policies"} description={access ? "Reusable sets of enabled tools and connections." : "Reusable allow and approval requirements for connected tools."} actions={<><ConfigurationDialog kind={kind} /><ReloadButton onClick={() => void query.refetch()} busy={query.isFetching} /></>}><QueryError error={query.error} />{query.isPending ? <LoadingRows /> : <Card><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Connections</TableHead><TableHead>Tools</TableHead><TableHead>Clients</TableHead><TableHead>Updated</TableHead><TableHead /></TableRow></TableHeader><TableBody>{rows.map((summary) => { const resource = "accessProfile" in summary ? summary.accessProfile : summary.approvalPolicy; return <TableRow key={resource.id} className={rowNavigates}><TableCell><RowLink to={`/${access ? "access-profiles" : "approval-policies"}/${resource.id}`}>{resource.name}</RowLink>{resource.isDefault ? <Badge className="ml-2">default</Badge> : null}</TableCell><TableCell>{summary.connectionCount}</TableCell><TableCell>{summary.toolCount}</TableCell><TableCell>{summary.assignedClientCount}</TableCell><TableCell>{when(resource.updatedAt)}</TableCell><TableCell className="relative z-10 text-right"><ConfigurationDialog kind={kind} source={{ id: resource.id, name: resource.name }} /></TableCell></TableRow>})}</TableBody></Table></CardContent></Card>}</Page>
}

export function AccessProfileDetailRoute() { const { accessProfileId } = useParams(); const query = useAccessProfile(accessProfileId); const resource = query.data?.accessProfile; return <ConfigurationDetail title="Access profile" back="/access-profiles" query={query} resource={resource}>{resource === undefined ? null : <AccessProfileEditor key={resource.updatedAt.toISOString()} id={resource.id} storedTools={query.data?.tools ?? []} assignedClientCount={query.data?.assignedClients.length ?? 0} />}</ConfigurationDetail> }
export function ApprovalPolicyDetailRoute() { const { approvalPolicyId } = useParams(); const query = useApprovalPolicy(approvalPolicyId); const resource = query.data?.approvalPolicy; return <ConfigurationDetail title="Approval policy" back="/approval-policies" query={query} resource={resource}>{resource === undefined ? null : <ApprovalPolicyEditor key={resource.updatedAt.toISOString()} id={resource.id} storedTools={query.data?.tools ?? []} assignedClientCount={query.data?.assignedClients.length ?? 0} />}</ConfigurationDetail> }

function ConfigurationDetail({ title, back, query, resource, children }: { readonly title: string; readonly back: string; readonly query: ReturnType<typeof useAccessProfile> | ReturnType<typeof useApprovalPolicy>; readonly resource: { readonly name: string; readonly isDefault: boolean } | undefined; readonly children: React.ReactNode }) { return <Page title={resource?.name ?? title} description={`Edit this reusable ${title.toLowerCase()}.`} actions={<ReloadButton onClick={() => void query.refetch()} busy={query.isFetching} />}><Button variant="ghost" size="sm" className="w-fit" asChild><Link to={back}><ArrowLeft className="size-3" />All {title.toLowerCase()}s</Link></Button><QueryError error={query.error} />{query.isPending ? <LoadingRows /> : <>{resource?.isDefault ? <Badge className="w-fit">default</Badge> : null}{children}</>}</Page> }
