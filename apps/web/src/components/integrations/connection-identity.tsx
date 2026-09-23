import { aliasForConnection, connectionRefOf } from "@mokronos/integrations-contracts"

import { IntegrationIcon, integrationHost } from "@/components/integrations/integration-icon"
import { Badge } from "@/components/ui/badge"
import type { ConnectionRef, IntegrationOverview } from "@/lib/schemas"
import { cn } from "@/lib/utils"

const connectionName = (connection: ConnectionRef, integration: IntegrationOverview | undefined): string => {
  const detail = integration?.connections.find((entry) =>
    entry.name === connection.name && entry.owner === (connection.owner === "org" ? "org" : `user:${connection.subject ?? ""}`)
  )
  return detail?.identityLabel || (connection.name === "default" ? "Default connection" : connection.name)
}

export function connectionForAlias(alias: string | null, integrations: ReadonlyArray<IntegrationOverview>): ConnectionRef | null {
  if (alias === null) return null
  for (const integration of integrations) {
    for (const connection of integration.connections) {
      const ref = connectionRefOf(connection.owner, connection.integration, connection.name)
      if (aliasForConnection(ref) === alias) return ref
    }
  }
  return null
}

export function ConnectionIdentity({
  connection,
  integration,
  showIntegration = true,
  className
}: {
  readonly connection: ConnectionRef
  readonly integration: IntegrationOverview | undefined
  readonly showIntegration?: boolean
  readonly className?: string
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      {showIntegration ? <IntegrationIcon host={integrationHost(integration ?? { slug: connection.integration })} size={24} /> : null}
      <span className="flex min-w-0 flex-col leading-tight">
        {showIntegration ? <span className="truncate font-medium">{integration?.name ?? connection.integration}</span> : null}
        <span className={cn("truncate", showIntegration && "text-muted-foreground text-xs")}>{connectionName(connection, integration)}</span>
      </span>
      <Badge variant="outline" className="shrink-0 text-[10px]">{connection.owner === "org" ? "Organization" : "User"}</Badge>
    </span>
  )
}

export function ToolIdentity({
  connection,
  alias,
  tool,
  integrations,
  className
}: {
  readonly connection: ConnectionRef | null
  readonly alias: string | null
  readonly tool: string | null
  readonly integrations: ReadonlyArray<IntegrationOverview>
  readonly className?: string
}) {
  const resolved = connection ?? connectionForAlias(alias, integrations)
  const integration = integrations.find((entry) => entry.slug === resolved?.integration)
  return (
    <span className={cn("flex min-h-14 min-w-0 flex-col gap-1", className)}>
      <span className="break-all font-mono text-sm font-medium">{tool ?? "Unknown tool"}</span>
      {resolved === null
        ? <span className="text-muted-foreground break-all text-xs">{alias ?? "Connection unavailable"}</span>
        : <ConnectionIdentity connection={resolved} integration={integration} />}
    </span>
  )
}
