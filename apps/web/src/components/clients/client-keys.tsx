import { useState } from "react"
import { toast } from "sonner"

import { IssueKeyButton } from "@/components/clients/issue-key-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
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
import * as gateway from "@/lib/gateway"
import { keys, useApiKeys, useInvalidate, useMutation } from "@/lib/queries"
import type { ApiKeyView, ClientId } from "@integragents/contracts"

function KeyRow({ keySummary, clientId }: {
  readonly keySummary: ApiKeyView
  readonly clientId: ClientId
}) {
  const invalidate = useInvalidate()
  const revoke = useMutation({
    mutationFn: () => gateway.revokeKey(keySummary.id),
    onSuccess: () => {
      invalidate(keys.apiKeys(clientId))
      toast.success("API key revoked")
    },
    onError: (error: Error) => toast.error("Could not revoke key", { description: error.message })
  })
  const revoked = keySummary.revokedAt !== null

  return (
    <TableRow className={revoked ? "opacity-55" : undefined}>
      <TableCell className="font-mono text-xs">{keySummary.id}</TableCell>
      <TableCell className="text-muted-foreground text-sm">{when(keySummary.createdAt)}</TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {keySummary.lastUsedAt === null ? "Never" : when(keySummary.lastUsedAt)}
      </TableCell>
      <TableCell>{revoked ? <Badge variant="outline">revoked {when(keySummary.revokedAt)}</Badge> : <Badge variant="secondary">live</Badge>}</TableCell>
      <TableCell className="text-right">
        {revoked ? null : (
          <Button variant="ghost" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            Revoke
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}

export function ClientKeys({ clientId, clientName, disabled }: {
  readonly clientId: ClientId
  readonly clientName: string
  readonly disabled: boolean
}) {
  const [showRevoked, setShowRevoked] = useState(false)
  const all = useApiKeys(clientId).data ?? []
  const live = all.filter((entry) => entry.revokedAt === null)
  const revoked = all.filter((entry) => entry.revokedAt !== null)
  const shown = showRevoked ? [...live, ...revoked] : live

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>Rotate one credential without revoking the whole client.</CardDescription>
        <CardAction>
          <IssueKeyButton clientId={clientId} clientName={clientName} disabled={disabled} />
        </CardAction>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Key ID</TableHead><TableHead>Created</TableHead><TableHead>Last used</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {shown.length === 0
              ? <TableRow><TableCell colSpan={5} className="text-muted-foreground py-8 text-center">{all.length === 0 ? "No keys issued." : "No live keys."}</TableCell></TableRow>
              : shown.map((entry) => <KeyRow key={entry.id} keySummary={entry} clientId={clientId} />)}
          </TableBody>
        </Table>
      </CardContent>
      {revoked.length === 0 ? null : (
        <CardFooter>
          <Button variant="ghost" size="sm" onClick={() => setShowRevoked((value) => !value)}>
            {showRevoked ? "Hide revoked keys" : `Show ${revoked.length} revoked ${revoked.length === 1 ? "key" : "keys"}`}
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}
