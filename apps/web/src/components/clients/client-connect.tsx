import { Cable } from "lucide-react"
import type { ClientId } from "@integragents/contracts"

import { ConnectTabs } from "@/components/clients/connect-tabs"
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
import { apiKeyPlaceholder } from "@/lib/mcp"
import { useApiKeys, useGatewayUrl, useMcpUrl } from "@/lib/queries"

export function ClientConnect({ clientId, clientName, disabled }: {
  readonly clientId: ClientId
  readonly clientName: string
  readonly disabled: boolean
}) {
  const gatewayUrl = useGatewayUrl()
  const mcpUrl = useMcpUrl()
  const liveKeys = (useApiKeys(clientId).data ?? []).filter((entry) => entry.revokedAt === null).length

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Cable className="size-4" /> Connect</CardTitle>
        <CardDescription>
          Give an agent or application access as this client, through the CLI, MCP, or the TypeScript client.
        </CardDescription>
        <CardAction>
          <IssueKeyButton clientId={clientId} clientName={clientName} disabled={disabled} variant={liveKeys === 0 ? "default" : "outline"} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {gatewayUrl.isPending || mcpUrl.isPending
          ? <LoadingRows rows={2} />
          : gatewayUrl.data === undefined || mcpUrl.data === undefined
          ? <p className="text-muted-foreground text-sm">
            This gateway has no public URL to name. Start it on loopback, or set
            <code className="mx-1 font-mono text-xs">INTEGRATIONS_PUBLIC_URL</code>
            to the address agents reach it at.
          </p>
          : <ConnectTabs clientName={clientName} gatewayUrl={gatewayUrl.data} mcpUrl={mcpUrl.data} apiKey={apiKeyPlaceholder} />}
      </CardContent>
    </Card>
  )
}
