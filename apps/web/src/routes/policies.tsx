import { ArrowLeft, FileKey2 } from "lucide-react"
import { Link, useParams } from "react-router"

import { CreatePolicyDialog, ClonePolicyDialog } from "@/components/policies/policy-dialogs"
import { PolicyEditor } from "@/components/policies/policy-editor"
import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { when } from "@/lib/format"
import { usePolicies, usePolicy } from "@/lib/queries"

export function PoliciesRoute() {
  const policies = usePolicies()
  return (
    <Page
      title="Policies"
      description="Reusable tool access rules shared by clients."
      actions={<><CreatePolicyDialog /><ReloadButton onClick={() => void policies.refetch()} busy={policies.isFetching} /></>}
    >
      <QueryError error={policies.error} />
      {policies.isPending ? <LoadingRows /> : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Policy</TableHead>
                <TableHead>Integrations</TableHead>
                <TableHead>Tools</TableHead>
                <TableHead>Assigned clients</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {(policies.data ?? []).length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-muted-foreground py-10 text-center">No policies yet.</TableCell></TableRow>
                ) : (policies.data ?? []).map((summary) => (
                  <TableRow key={summary.policy.id}>
                    <TableCell>
                      <Link className="font-medium hover:underline" to={`/policies/${summary.policy.id}`}>{summary.policy.name}</Link>
                      <div className="mt-1 flex items-center gap-2">
                        <code className="text-muted-foreground text-xs">{summary.policy.id}</code>
                        {summary.policy.isDefault ? <Badge>default</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell>{summary.integrationCount}</TableCell>
                    <TableCell>{summary.enabledToolCount}/{summary.toolCount}</TableCell>
                    <TableCell>{summary.assignedClientCount}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{when(summary.policy.updatedAt)}</TableCell>
                    <TableCell className="text-right"><ClonePolicyDialog policyId={summary.policy.id} policyName={summary.policy.name} /></TableCell>
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

export function PolicyDetailRoute() {
  const { policyId } = useParams()
  const detail = usePolicy(policyId)
  if (policyId === undefined) return null
  const policy = detail.data?.policy
  const clients = detail.data?.assignedClients ?? []

  return (
    <Page
      title={policy?.name ?? "Policy"}
      description="Choose the complete set of tools clients assigned to this policy may use."
      actions={policy === undefined ? undefined : <><ClonePolicyDialog policyId={policy.id} policyName={policy.name} /><ReloadButton onClick={() => void detail.refetch()} busy={detail.isFetching} /></>}
    >
      <Button variant="ghost" size="sm" className="w-fit" asChild><Link to="/policies"><ArrowLeft className="size-3" />All policies</Link></Button>
      <QueryError error={detail.error} />
      {detail.isPending ? <LoadingRows /> : policy === undefined ? null : (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <FileKey2 className="size-4" />
                <CardTitle>{policy.name}</CardTitle>
                {policy.isDefault ? <Badge>default policy</Badge> : null}
                <Badge variant="secondary">{clients.length} assigned client{clients.length === 1 ? "" : "s"}</Badge>
              </div>
              <CardDescription>
                Updated {when(policy.updatedAt)}. {clients.length === 0 ? "No clients currently use this policy." : `Used by ${clients.map((client) => client.name).join(", ")}.`}
              </CardDescription>
            </CardHeader>
          </Card>
          <PolicyEditor
            key={`${policy.id}:${policy.updatedAt.toISOString()}`}
            policyId={policy.id}
            storedIntegrations={detail.data?.integrations ?? []}
            storedTools={detail.data?.tools ?? []}
            assignedClientCount={clients.length}
          />
        </>
      )}
    </Page>
  )
}
