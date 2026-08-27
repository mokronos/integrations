
import { Badge } from "@/components/ui/badge"
import type { IntegrationOverview } from "@/lib/schemas"
const isConnected = (integration: IntegrationOverview): boolean =>
  integration.connections.length > 0

export function ConnectionBadge({ integration }: { readonly integration: IntegrationOverview }) {
  if (isConnected(integration)) return <Badge>connected</Badge>
  return (
    <Badge variant={integration.requiresAuthentication ? "destructive" : "secondary"}>
      {integration.requiresAuthentication ? "needs auth" : "not connected"}
    </Badge>
  )
}
