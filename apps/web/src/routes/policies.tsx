import { ArrowLeft } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import { Option, Schema } from "effect"
import { AccessProfileId, ApprovalPolicyId } from "@mokronos/integrations-contracts"
import { accessProfileKind, approvalPolicyKind, type ConfigurationKind, type ConfigurationResource } from "@/components/policies/configuration-kinds"
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
import { keys, refetchAll, useAccessProfile, useAccessProfiles, useApprovalPolicies, useApprovalPolicy, useInvalidate, useMutation } from "@/lib/queries"

type ConfigurationRow<Id extends string> = {
  readonly resource: ConfigurationResource<Id>
  readonly connectionCount: number
  readonly toolCount: number
  readonly assignedClientCount: number
}

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export function AccessProfilesRoute() {
  const query = useAccessProfiles()
  const rows = query.data?.map(({ accessProfile, ...counts }) => ({ resource: accessProfile, ...counts }))
  return <ConfigurationList kind={accessProfileKind} title="Access profiles" description="Reusable sets of enabled tools and connections." query={query} rows={rows} />
}

export function ApprovalPoliciesRoute() {
  const query = useApprovalPolicies()
  const rows = query.data?.map(({ approvalPolicy, ...counts }) => ({ resource: approvalPolicy, ...counts }))
  return <ConfigurationList kind={approvalPolicyKind} title="Approval policies" description="Reusable allow and approval requirements for connected tools." query={query} rows={rows} />
}

function ConfigurationList<Id extends string>({ kind, title, description, query, rows }: {
  readonly kind: ConfigurationKind<Id>
  readonly title: string
  readonly description: string
  readonly query: ReturnType<typeof useAccessProfiles> | ReturnType<typeof useApprovalPolicies>
  readonly rows: ReadonlyArray<ConfigurationRow<Id>> | undefined
}) {
  return <Page title={title} description={description} actions={<><ConfigurationDialog kind={kind} /><ReloadButton onClick={() => refetchAll(query)} /></>}><QueryError error={query.error} />{query.isPending ? <LoadingRows /> : <Card><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Connections</TableHead><TableHead>Tools</TableHead><TableHead>Clients</TableHead><TableHead>Updated</TableHead><TableHead /></TableRow></TableHeader><TableBody>{(rows ?? []).map(({ resource, ...summary }) => <TableRow key={resource.id} className={rowNavigates}><TableCell><RowLink to={`${kind.path}/${resource.id}`}>{resource.name}</RowLink>{resource.isDefault ? <Badge className="ml-2">default</Badge> : null}</TableCell><TableCell>{summary.connectionCount}</TableCell><TableCell>{summary.toolCount}</TableCell><TableCell>{summary.assignedClientCount}</TableCell><TableCell>{when(resource.updatedAt)}</TableCell><TableCell className="relative z-10 text-right"><span className="inline-flex items-center gap-1"><ConfigurationDialog kind={kind} source={resource} />{resource.isDefault ? null : <DeleteConfiguration kind={kind} resource={resource} assignedClientCount={summary.assignedClientCount} />}</span></TableCell></TableRow>)}</TableBody></Table></CardContent></Card>}</Page>
}

const decodeAccessProfileId = Schema.decodeUnknownOption(AccessProfileId)
const decodeApprovalPolicyId = Schema.decodeUnknownOption(ApprovalPolicyId)

export function AccessProfileDetailRoute() {
  const query = useAccessProfile(Option.getOrUndefined(decodeAccessProfileId(useParams()["accessProfileId"])))
  const resource = query.data?.accessProfile
  return <ConfigurationDetail kind={accessProfileKind} query={query} resource={resource}>{resource === undefined ? null : <AccessProfileEditor key={resource.updatedAt.toISOString()} id={resource.id} storedTools={query.data?.tools ?? []} assignedClientCount={query.data?.assignedClients.length ?? 0} />}</ConfigurationDetail>
}

export function ApprovalPolicyDetailRoute() {
  const query = useApprovalPolicy(Option.getOrUndefined(decodeApprovalPolicyId(useParams()["approvalPolicyId"])))
  const resource = query.data?.approvalPolicy
  return <ConfigurationDetail kind={approvalPolicyKind} query={query} resource={resource}>{resource === undefined ? null : <ApprovalPolicyEditor key={resource.updatedAt.toISOString()} id={resource.id} storedTools={query.data?.tools ?? []} assignedClientCount={query.data?.assignedClients.length ?? 0} />}</ConfigurationDetail>
}

function ConfigurationDetail<Id extends string>({ kind, query, resource, children }: {
  readonly kind: ConfigurationKind<Id>
  readonly query: ReturnType<typeof useAccessProfile> | ReturnType<typeof useApprovalPolicy>
  readonly resource: ConfigurationResource<Id> | undefined
  readonly children: React.ReactNode
}) {
  const invalidate = useInvalidate()
  const assignedClientCount = query.data?.assignedClients.length ?? 0
  const rename = useMutation({
    mutationFn: ({ id, name }: { readonly id: Id; readonly name: string }) => kind.rename(id, name),
    onSuccess: (renamed) => { invalidate(...kind.queryKeys(renamed.id), keys.clients, keys.overview); toast.success(`Now called ${renamed.name}`) },
    onError: (error: Error) => toast.error(`Could not rename ${kind.label}`, { description: error.message })
  })
  return <Page
    title={resource === undefined ? capitalised(kind.label) : <><EditableTitle value={resource.name} onSave={(name) => rename.mutate({ id: resource.id, name })} saving={rename.isPending} />{resource.isDefault ? <Badge>default</Badge> : null}</>}
    description={`Edit this reusable ${kind.label}.`}
    actions={<>{resource === undefined || resource.isDefault ? null : <DeleteConfiguration kind={kind} resource={resource} assignedClientCount={assignedClientCount} />}</>}
  >
    <Button variant="ghost" size="sm" className="w-fit" render={<Link to={kind.path} />}><ArrowLeft className="size-3" />All {kind.label}s</Button>
    <QueryError error={query.error} />
    {query.isPending ? <LoadingRows /> : children}
  </Page>
}

function DeleteConfiguration<Id extends string>({ kind, resource, assignedClientCount }: {
  readonly kind: ConfigurationKind<Id>
  readonly resource: ConfigurationResource<Id>
  readonly assignedClientCount: number
}) {
  const invalidate = useInvalidate()
  const navigate = useNavigate()
  const remove = useMutation({
    mutationFn: () => kind.remove(resource.id),
    onSuccess: () => { invalidate(...kind.queryKeys(resource.id), keys.overview); toast.success(`${resource.name} deleted`); void navigate(kind.path) },
    onError: (error: Error) => toast.error(`Could not delete ${kind.label}`, { description: error.message })
  })
  const blocked = assignedClientCount > 0
  return <ConfirmButton
    label="Delete"
    title={`Delete ${resource.name}?`}
    description={blocked
      ? `${assignedClientCount} client${assignedClientCount === 1 ? " is" : "s are"} still assigned to this ${kind.label}. Reassign them before deleting it.`
      : `The ${kind.label} and its tool rules are removed. Clients cannot be assigned to it afterwards.`}
    confirmLabel="Delete"
    pendingLabel="Deleting…"
    pending={remove.isPending}
    blocked={blocked}
    onConfirm={() => remove.mutateAsync().then(() => undefined)}
  />
}
