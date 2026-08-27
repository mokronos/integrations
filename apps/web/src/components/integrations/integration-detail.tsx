import { ExternalLink, Plug, Search, Unplug } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { JsonView } from "@/components/json-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { when } from "@/lib/format"
import * as gateway from "@/lib/gateway"
import { keys, useInvalidate, useMutation } from "@/lib/queries"
import {
  type Connection,
  type IntegrationOverview,
  type Tool
} from "@/lib/schemas"
import { ConnectDialog } from "./connect-dialog"
import { ConnectionBadge } from "./connection-badge"
const isConnected = (integration: IntegrationOverview): boolean =>
  integration.connections.length > 0

const expiry = (connection: Connection): string =>
  connection.expiresAt === undefined || connection.expiresAt === null
    ? "no expiry"
    : `expires ${when(new Date(connection.expiresAt))}`
function ToolCard({ tool }: { readonly tool: Tool }) {
  return (
    <details className="group min-w-0 rounded-lg border p-3">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2">
        <span className="min-w-0 truncate font-medium">{tool.name}</span>
        <Badge variant="outline">{tool.connection}</Badge>
        <code className="text-muted-foreground ml-auto min-w-0 truncate font-mono text-xs">
          {tool.address}
        </code>
      </summary>
      <div className="mt-3 space-y-3">
        {tool.description.length === 0
          ? null
          : <p className="text-muted-foreground text-sm">{tool.description}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <JsonView value={tool.inputSchema ?? null} label="input schema" />
          <JsonView value={tool.outputSchema ?? null} label="output schema" />
        </div>
      </div>
    </details>
  )
}

export function IntegrationDetail({ integration }: { readonly integration: IntegrationOverview }) {
  const invalidate = useInvalidate()
  const [filter, setFilter] = useState("")

  const disconnect = useMutation({
    mutationFn: (connection: Connection) =>
      gateway.removeConnection({ integration: integration.slug, name: connection.name }),
    onSuccess: () => {
      invalidate(keys.integrations, keys.connections)
      toast.success("Connection removed")
    },
    onError: (error: Error) => toast.error("Could not disconnect", { description: error.message })
  })

  const tools = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle.length === 0) return integration.tools
    return integration.tools.filter((tool) =>
      `${tool.name} ${tool.address} ${tool.description}`.toLowerCase().includes(needle)
    )
  }, [filter, integration.tools])

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Plug className="size-4" />
            <CardTitle className="min-w-0 break-words">{integration.name}</CardTitle>
            <ConnectionBadge integration={integration} />
            <div className="ml-auto">
              <ConnectDialog integration={integration} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-muted-foreground text-xs uppercase">Slug</dt>
              <dd><code className="break-all font-mono">{integration.slug}</code></dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground text-xs uppercase">Kind</dt>
              <dd>{integration.kind}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground text-xs uppercase">Auth</dt>
              <dd>
                {integration.authMethods.length === 0
                  ? "none"
                  : integration.authMethods.map((method) => `${method.template}:${method.kind}`)
                    .join(", ")}
              </dd>
            </div>
          </dl>

          {integration.displayUrl === undefined ? null : (
            <a
              className="text-primary inline-flex max-w-full items-center gap-1 break-all text-sm hover:underline"
              href={integration.displayUrl}
              target="_blank"
              rel="noreferrer"
            >
              {integration.displayUrl}
              <ExternalLink className="size-3 shrink-0" />
            </a>
          )}

          {integration.description.length === 0
            ? null
            : <p className="text-muted-foreground text-sm">{integration.description}</p>}

          <Separator />

          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide">Connections</p>
            {integration.connections.length === 0
              ? <p className="text-muted-foreground text-sm">Not connected.</p>
              : (
                <ul className="space-y-2">
                  {integration.connections.map((connection) => (
                    <li
                      key={connection.address}
                      className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
                    >
                      <span className="font-medium">{connection.name}</span>
                      <Badge variant="outline">{connection.owner}</Badge>
                      <Badge variant="secondary">{connection.template}</Badge>
                      {connection.identityLabel === undefined || connection.identityLabel === null
                        ? null
                        : <span className="text-muted-foreground">{connection.identityLabel}</span>}
                      <span className="text-muted-foreground text-xs">{expiry(connection)}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() => disconnect.mutate(connection)}
                        disabled={disconnect.isPending}
                      >
                        <Unplug className="size-3" />
                        Disconnect
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Tools</CardTitle>
            <div className="relative w-full sm:w-64">
              <Search className="text-muted-foreground absolute left-2 top-1/2 size-3.5 -translate-y-1/2" />
              <Input
                className="pl-7"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter tools"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {integration.toolError === undefined ? null : (
            <p className="text-destructive text-sm">{integration.toolError}</p>
          )}
          {integration.tools.length === 0
            ? (
              <p className="text-muted-foreground text-sm">
                {isConnected(integration)
                  ? "This connection exposes no callable tools."
                  : "Connect it to see what it exposes."}
              </p>
            )
            : tools.length === 0
              ? <p className="text-muted-foreground text-sm">Nothing matches that filter.</p>
              : tools.map((tool) => <ToolCard key={tool.address} tool={tool} />)}
        </CardContent>
      </Card>
    </div>
  )
}

