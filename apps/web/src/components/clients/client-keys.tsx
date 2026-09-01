import { Copy, KeyRound, Plug } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
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
import { mcpConfiguration } from "@/lib/mcp"
import {
  useInvalidate,
  useMcpUrl,
  useMutation,
  useQuery
} from "@/lib/queries"
import type { ApiKeySummary } from "@/lib/schemas"

function KeyRow({ keySummary, clientId }: {
  readonly keySummary: ApiKeySummary
  readonly clientId: string
}) {
  const invalidate = useInvalidate()
  const revoke = useMutation({
    mutationFn: () => gateway.revokeKey(keySummary.id),
    onSuccess: () => {
      invalidate(["keys", clientId])
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
        <Button variant="ghost" size="sm" disabled={revoked || revoke.isPending} onClick={() => revoke.mutate()}>
          Revoke
        </Button>
      </TableCell>
    </TableRow>
  )
}

export function ClientKeys({ clientId, clientName, disabled }: {
  readonly clientId: string
  readonly clientName: string
  readonly disabled: boolean
}) {
  const invalidate = useInvalidate()
  const mcpUrl = useMcpUrl().data
  const [secret, setSecret] = useState<string | undefined>()
  const keysQuery = useQuery({
    queryKey: ["keys", clientId],
    queryFn: () => gateway.listKeys(clientId)
  })
  const issue = useMutation({
    mutationFn: () => gateway.issueKey(clientId),
    onSuccess: (issued) => {
      setSecret(issued.secret)
      invalidate(["keys", clientId])
    },
    onError: (error: Error) => toast.error("Could not issue key", { description: error.message })
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" /> API keys</CardTitle>
        <CardDescription>Rotate one credential without revoking the whole client.</CardDescription>
        <CardAction>
          <Button size="sm" onClick={() => issue.mutate()} disabled={disabled || issue.isPending}>Issue key</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Key ID</TableHead><TableHead>Created</TableHead><TableHead>Last used</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {(keysQuery.data ?? []).length === 0
              ? <TableRow><TableCell colSpan={5} className="text-muted-foreground py-8 text-center">No keys issued.</TableCell></TableRow>
              : (keysQuery.data ?? []).map((entry) => <KeyRow key={entry.id} keySummary={entry} clientId={clientId} />)}
          </TableBody>
        </Table>
      </CardContent>
      <Dialog open={secret !== undefined} onOpenChange={(next) => next ? undefined : setSecret(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy this key now</DialogTitle>
            <DialogDescription>The gateway stores only its hash. The plaintext cannot be shown again.</DialogDescription>
          </DialogHeader>
          <code className="bg-muted block break-all rounded-md p-3 font-mono text-sm">{secret}</code>
          {/* The only moment the plaintext exists is also the only moment a
              ready-to-paste MCP configuration can carry it, so it is offered
              here rather than left to be assembled by hand afterwards. */}
          {mcpUrl === undefined ? null : (
            <p className="text-muted-foreground text-xs">
              Or take it as MCP client configuration, with the key already in it.
            </p>
          )}
          <DialogFooter>
            {mcpUrl === undefined ? null : (
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(mcpConfiguration(clientName, mcpUrl, secret ?? ""))
                  toast.success("MCP configuration copied")
                }}
              >
                <Plug className="size-4" /> Copy MCP configuration
              </Button>
            )}
            <Button onClick={() => { void navigator.clipboard.writeText(secret ?? ""); toast.success("Key copied") }}>
              <Copy className="size-4" /> Copy key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
