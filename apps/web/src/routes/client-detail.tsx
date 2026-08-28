import { ArrowLeft, ShieldAlert } from "lucide-react"
import { useMemo } from "react"
import { Link, useParams } from "react-router"

import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { when } from "@/lib/format"
import {
  useClients,
  useGrants
} from "@/lib/queries"

import { GrantDialog, GrantRow } from "@/components/clients/client-grants"
import { ClientKeys } from "@/components/clients/client-keys"
import { ClientSettings } from "@/components/clients/client-settings"
export function ClientDetailRoute() {
  const { clientId } = useParams()
  const clients = useClients()
  const grants = useGrants(clientId)

  const client = useMemo(
    () => (clients.data ?? []).find((candidate) => candidate.id === clientId),
    [clients.data, clientId]
  )

  if (clientId === undefined) return null

  return (
    <Page
      title={client?.name ?? "Client"}
      description="Everything this client may reach. Nothing else is visible to it."
      actions={
        <>
          <GrantDialog clientId={clientId} />
          <ReloadButton onClick={() => void grants.refetch()} busy={grants.isFetching} />
        </>
      }
    >
      <Button variant="ghost" size="sm" className="w-fit" asChild>
        <Link to="/clients">
          <ArrowLeft className="size-3" />
          All clients
        </Link>
      </Button>

      <QueryError error={grants.error ?? clients.error} />

      {client === undefined ? null : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <code className="font-mono text-sm">{client.id}</code>
                {client.capabilities.includes("administer_gateway")
                  ? (
                    <Badge variant="destructive" className="gap-1">
                      <ShieldAlert className="size-3" />
                      administrator
                    </Badge>
                  )
                  : <Badge variant="secondary">client</Badge>}
                {client.revokedAt === null
                  ? null
                  : <Badge variant="outline">revoked {when(client.revokedAt)}</Badge>}
              </CardTitle>
            </CardHeader>
            {client.capabilities.includes("administer_gateway")
              ? (
                <CardContent className="text-muted-foreground text-sm">
                  This client can administer clients, keys, grants, audit, and
                  gateway policy. Tool invocation still resolves through grants.
                </CardContent>
              )
              : null}
          </Card>
          <ClientSettings key={`${client.id}:${client.capabilities.join(",")}:${JSON.stringify(client.approvalDelivery)}`} client={client} />
          <ClientKeys clientId={clientId} disabled={client.revokedAt !== null} />
        </>
      )}

      {grants.isPending
        ? <LoadingRows />
        : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Alias</TableHead>
                    <TableHead>Tool</TableHead>
                    <TableHead>Connection</TableHead>
                    <TableHead>Decision</TableHead>
                    <TableHead>Granted</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(grants.data ?? []).length === 0
                    ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-muted-foreground py-10 text-center">
                          No grants. This client can see nothing.
                        </TableCell>
                      </TableRow>
                    )
                    : (grants.data ?? []).map((grant) => (
                      <GrantRow key={grant.id} grant={grant} clientId={clientId} />
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
    </Page>
  )
}
