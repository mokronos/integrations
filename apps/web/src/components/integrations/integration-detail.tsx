import { ChevronRight, ExternalLink, Search, Unplug } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { connectionRefOf } from "@integragents/contracts"

import { SchemaView } from "@/components/schema-view"
import { AuthMethodDetails } from "@/components/integrations/auth-method-details"
import { OperationError } from "@/components/integrations/operation-feedback"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ConfirmButton } from "@/components/ui/confirm-button"
import { EditableTitle } from "@/components/ui/editable-title"
import { Input } from "@/components/ui/input"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Separator } from "@/components/ui/separator"
import { pluralise, when } from "@/lib/format"
import * as gateway from "@/lib/gateway"
import { keys, useInvalidate, useMutation } from "@/lib/queries"
import {
  type Connection,
  type IntegrationOverview,
  type Tool
} from "@integragents/contracts"
import { cn } from "@/lib/utils"
import { ConnectDialog } from "./connect-dialog"
import { ConnectionBadge } from "./connection-badge"
import { ConnectionIdentity } from "./connection-identity"
import { IntegrationIcon, integrationHost } from "./integration-icon"
const isConnected = (integration: IntegrationOverview): boolean =>
  integration.connections.some((connection) => connection.status === "connected")

const expiry = (connection: Connection): string =>
  connection.expiresAt === undefined || connection.expiresAt === null
    ? "no expiry"
    : `expires ${when(new Date(connection.expiresAt))}`

const connectionAuthLabel = (
  integration: IntegrationOverview,
  connection: Connection
): string => integration.authMethods.find((method) => method.template === connection.template)?.label
  ?? `Unavailable method (${connection.template})`
function ToolCard({ tool }: { readonly tool: Tool }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0 rounded-lg border">
      <Item
        render={
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} />
        }
        className="cursor-pointer select-none hover:bg-muted"
      >
        <ItemMedia>
            <ChevronRight
              aria-hidden
              className={cn("size-4 transition-transform", open && "rotate-90")}
            />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>
              <span className="min-w-0 truncate">{tool.name}</span>
              <Badge variant="outline" className="shrink-0">{tool.connection}</Badge>
            </ItemTitle>
            {tool.description.length === 0
              ? null
              : <ItemDescription className="truncate">{tool.description}</ItemDescription>}
          </ItemContent>
      </Item>

      {open
        ? (
          <div className="space-y-3 border-t p-3">
            {tool.description.length === 0
              ? null
              : <p className="text-muted-foreground text-sm">{tool.description}</p>}
            <div className="grid min-w-0 gap-2 xl:grid-cols-2">
              <SchemaView
                schema={tool.inputSchema}
                definitions={tool.schemaDefinitions}
                label="input"
              />
              <SchemaView
                schema={tool.outputSchema}
                definitions={tool.schemaDefinitions}
                label="output"
              />
            </div>
          </div>
        )
        : null}
    </div>
  )
}

function RemoveIntegration({ integration }: { readonly integration: IntegrationOverview }) {
  const invalidate = useInvalidate()
  const navigate = useNavigate()
  const remove = useMutation({
    mutationFn: () => gateway.removeIntegration(integration.slug),
    onSuccess: (result) => {
      invalidate(keys.integrations, keys.connections, keys.overview)
      toast.success(`${integration.name} removed`, {
        description: result.connections.length === 0
          ? undefined
          : `${pluralise(result.connections.length, "connection")} removed with it.`
      })
      void navigate("/integrations")
    },
    onError: (error: Error) =>
      toast.error("Could not remove the integration", { description: error.message })
  })

  return (
    <ConfirmButton
      label="Remove"
      title={`Remove ${integration.name}?`}
      description="The gateway forgets this integration and its tools. Any workflow addressing them stops resolving. Discovering the same URL again installs it fresh."
      confirmLabel="Remove"
      pendingLabel="Removing…"
      pending={remove.isPending}
      onConfirm={() => remove.mutateAsync().then(() => undefined)}
    >
      {integration.connections.length === 0
        ? null
        : (
          <div className="space-y-1 text-sm">
            <p>
              {pluralise(integration.connections.length, "connection")} goes with it,
              along with the stored credentials and every policy rule naming them:
            </p>
            <ul className="text-muted-foreground list-inside list-disc font-mono text-xs">
              {integration.connections.map((connection) => (
                <li key={connection.address}>{connection.name}</li>
              ))}
            </ul>
          </div>
        )}
    </ConfirmButton>
  )
}

function IntegrationName({ integration }: { readonly integration: IntegrationOverview }) {
  const invalidate = useInvalidate()
  const rename = useMutation({
    mutationFn: (name: string) => gateway.renameIntegration({ slug: integration.slug, name }),
    onSuccess: (result) => {
      invalidate(keys.integrations, keys.overview)
      toast.success(`Now called ${result.name}`)
    },
    onError: (error: Error) => toast.error("Could not rename it", { description: error.message })
  })
  return (
    <CardTitle className="min-w-0 truncate">
      <EditableTitle value={integration.name} onSave={(name) => rename.mutate(name)} saving={rename.isPending} />
    </CardTitle>
  )
}

function ConnectionRow({ integration, connection, onDisconnect, disconnecting }: {
  readonly integration: IntegrationOverview
  readonly connection: Connection
  readonly onDisconnect: () => void
  readonly disconnecting: boolean
}) {
  return (
    <li className="min-w-0">
      <Item variant="outline" size="sm">
        <ItemContent>
          <ItemTitle>
            <ConnectionIdentity connection={connectionRefOf(connection.owner, connection.integration, connection.name)} integration={integration} showIntegration={false} />
            <Badge variant={connection.status === "connected" ? "default" : "destructive"}>
              {connection.status === "connected" ? "connected" : "reauthorization required"}
            </Badge>
          </ItemTitle>
          <ItemDescription className="flex flex-wrap items-center gap-2">
            <span>{expiry(connection)}</span>
            <span>via {connectionAuthLabel(integration, connection)}</span>
          </ItemDescription>
          {connection.oauthScope === undefined || connection.oauthScope === null
            ? null
            : <ItemDescription>OAuth scopes: {connection.oauthScope}</ItemDescription>}
          {connection.missingOAuthScopes === undefined || connection.missingOAuthScopes.length === 0
            ? null
            : <ItemDescription className="text-destructive">Missing scopes: {connection.missingOAuthScopes.join(", ")}</ItemDescription>}
          {connection.error === undefined ? null : (
            <p className="text-destructive mt-1 text-xs">{connection.error}</p>
          )}
        </ItemContent>
        <ItemActions>
          <Button variant="ghost" size="sm" onClick={onDisconnect} disabled={disconnecting}>
            <Unplug className="size-3" />
            Disconnect
          </Button>
        </ItemActions>
      </Item>
    </li>
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
    }
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
          <div className="flex min-w-0 items-center gap-2">
            <IntegrationIcon host={integrationHost(integration)} size={20} />
            <IntegrationName integration={integration} />
            <ConnectionBadge integration={integration} />
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <ConnectDialog key={integration.slug} integration={integration} />
              <RemoveIntegration integration={integration} />
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
              <dt className="text-muted-foreground text-xs uppercase">Authentication</dt>
              <dd>{integration.requiresAuthentication ? "Required" : "Not required"}</dd>
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
            <div>
              <p className="text-xs uppercase tracking-wide">Authentication options</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Discovered from the {integration.kind === "mcp" ? "MCP endpoint" : "OpenAPI document"}. Each connection uses one option.
              </p>
            </div>
            {integration.authMethods.length === 0
              ? <p className="text-destructive text-sm">No supported authentication option was discovered.</p>
              : (
                <div className="grid gap-2 xl:grid-cols-2">
                  {integration.authMethods.map((method) => <AuthMethodDetails key={method.id} method={method} />)}
                </div>
              )}
          </div>

          <Separator />

          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide">Connections</p>
            {integration.connections.length === 0
              ? <p className="text-muted-foreground text-sm">Not connected.</p>
              : (
                <ul className="space-y-2">
                  {integration.connections.map((connection) => (
                    <ConnectionRow
                      key={connection.address}
                      integration={integration}
                      connection={connection}
                      onDisconnect={() => disconnect.mutate(connection)}
                      disconnecting={disconnect.isPending}
                    />
                  ))}
                </ul>
              )}
            {disconnect.error === null ? null : (
              <OperationError title="Disconnect failed" step="Removing the stored connection" error={disconnect.error} />
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
            <Alert variant="destructive">
              <AlertTitle>Could not refresh tools</AlertTitle>
              <AlertDescription>
                <p><span className="font-medium">Stopped at:</span> Reading tools from the live endpoint</p>
                <p>{integration.toolError}</p>
              </AlertDescription>
            </Alert>
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
