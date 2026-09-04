
import { Badge } from "@/components/ui/badge"
import type { IntegrationOverview } from "@/lib/schemas"
const isConnected = (integration: IntegrationOverview): boolean =>
  integration.connections.some((connection) => connection.status === "connected")

const needsAuthorization = (integration: IntegrationOverview): boolean =>
  integration.connections.some((connection) => connection.status === "reauthorization_required")

export function ConnectionBadge({ integration }: { readonly integration: IntegrationOverview }) {
  if (isConnected(integration)) return <Badge>connected</Badge>
  if (needsAuthorization(integration)) return <Badge variant="destructive">needs auth</Badge>
  return (
    <Badge variant={integration.requiresAuthentication ? "destructive" : "secondary"}>
      {integration.requiresAuthentication ? "needs auth" : "not connected"}
    </Badge>
  )
}
