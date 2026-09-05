
import { Badge } from "@/components/ui/badge"
import type { IntegrationOverview } from "@/lib/schemas"

export function ConnectionBadge({ integration }: { readonly integration: IntegrationOverview }) {
  const connected = integration.connections.filter((connection) => connection.status === "connected").length
  const needsAuthorization = integration.connections.filter((connection) => connection.status === "reauthorization_required").length
  if (connected > 0 || needsAuthorization > 0) {
    return (
      <>
        {connected === 0 ? null : <Badge>{connected === 1 ? "connected" : `${connected} connected`}</Badge>}
        {needsAuthorization === 0 ? null : (
          <Badge variant="destructive">
            {needsAuthorization === 1 ? "1 needs auth" : `${needsAuthorization} need auth`}
          </Badge>
        )}
      </>
    )
  }
  return (
    <Badge variant={integration.requiresAuthentication ? "destructive" : "secondary"}>
      {integration.requiresAuthentication ? "needs auth" : "not connected"}
    </Badge>
  )
}
