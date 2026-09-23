import { Plug } from "lucide-react"

import { AgentConnect } from "@/components/clients/agent-connect"
import { IssueKeyButton } from "@/components/clients/issue-key-button"
import { LoadingRows } from "@/components/page"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { CopyField } from "@/components/ui/copy-field"
import { apiKeyPlaceholder } from "@/lib/mcp"
import { useApiKeys, useMcpUrl } from "@/lib/queries"

export function ClientMcp({ clientId, clientName, disabled }: {
  readonly clientId: string
  readonly clientName: string
  readonly disabled: boolean
}) {
  const mcpUrl = useMcpUrl()
  const url = mcpUrl.data
  const liveKeys = (useApiKeys(clientId).data ?? []).filter((entry) => entry.revokedAt === null).length

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Plug className="size-4" /> Connect over MCP</CardTitle>
        <CardDescription>
          Connect with browser login, then choose the Gateway Client the MCP application may act as.
        </CardDescription>
        <CardAction>
          <IssueKeyButton clientId={clientId} clientName={clientName} disabled={disabled} variant={liveKeys === 0 ? "default" : "outline"} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {mcpUrl.isPending
          ? <LoadingRows rows={2} />
          : url === undefined
          ? <p className="text-muted-foreground text-sm">
            This gateway has no public URL to name. Start it on loopback, or set
            <code className="mx-1 font-mono text-xs">INTEGRATIONS_PUBLIC_URL</code>
            to the address agents reach it at.
          </p>
          : <>
            <Field label="Endpoint">
              <CopyField value={url} label="Endpoint" />
            </Field>
            <Field label="Add to your coding agent">
              <AgentConnect clientName={clientName} url={url} apiKey={apiKeyPlaceholder} />
            </Field>
          </>}
      </CardContent>
    </Card>
  )
}

function Field({ label, children }: {
  readonly label: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      {children}
    </div>
  )
}
