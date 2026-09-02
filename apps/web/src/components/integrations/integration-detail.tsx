import { ChevronRight, ExternalLink, Search, Trash2, Unplug } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { SchemaView } from "@/components/schema-view"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
} from "@/lib/schemas"
import { cn } from "@/lib/utils"
import { ConnectDialog } from "./connect-dialog"
import { ConnectionBadge } from "./connection-badge"
import { IntegrationIcon, integrationHost } from "./integration-icon"
const isConnected = (integration: IntegrationOverview): boolean =>
  integration.connections.length > 0

const expiry = (connection: Connection): string =>
  connection.expiresAt === undefined || connection.expiresAt === null
    ? "no expiry"
    : `expires ${when(new Date(connection.expiresAt))}`
/** One tool, closed until asked about. The header is the whole click target —
 *  a row that only responds on its words is a row people click twice. */
function ToolCard({ tool }: { readonly tool: Tool }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0 rounded-lg border">
      <Item asChild interactive variant="plain">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ItemMedia>
            <ChevronRight
              aria-hidden
              className={cn("size-4 transition-transform", open && "rotate-90")}
            />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>
              <span className="min-w-0 truncate">{tool.name}</span>
              <Badge variant="outline">{tool.connection}</Badge>
            </ItemTitle>
            {tool.description.length === 0
              ? null
              : <ItemDescription className="truncate">{tool.description}</ItemDescription>}
          </ItemContent>
          <code className="text-muted-foreground hidden max-w-[40%] shrink-0 truncate font-mono text-xs sm:block">
            {tool.address}
          </code>
        </button>
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

/** Removing an integration is not one deletion, and the confirmation says what
 *  else goes: connections are removed with their credentials, and the policy
 *  rules that named them go too. A reader who only sees the integration's name
 *  cannot weigh that. */
function RemoveIntegration({ integration }: { readonly integration: IntegrationOverview }) {
  const invalidate = useInvalidate()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const remove = useMutation({
    mutationFn: () => gateway.removeIntegration(integration.slug),
    onSuccess: (result) => {
      setOpen(false)
      invalidate(keys.integrations, keys.connections, keys.overview)
      toast.success(`${integration.name} removed`, {
        description: result.connections.length === 0
          ? undefined
          : `${pluralise(result.connections.length, "connection")} removed with it.`
      })
      // The route addressed the integration by slug, and the slug no longer
      // resolves.
      void navigate("/integrations")
    },
    onError: (error: Error) =>
      toast.error("Could not remove the integration", { description: error.message })
  })

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
          <Trash2 className="size-3" />
          Remove
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {integration.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The gateway forgets this integration and its tools. Any workflow
            addressing them stops resolving. Discovering the same URL again
            installs it fresh.
          </AlertDialogDescription>
        </AlertDialogHeader>
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
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Keep it</AlertDialogCancel>
          <AlertDialogAction
            disabled={remove.isPending}
            onClick={(event) => {
              event.preventDefault()
              remove.mutate()
            }}
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
            <IntegrationIcon host={integrationHost(integration)} size={20} />
            <CardTitle className="min-w-0 break-words">{integration.name}</CardTitle>
            <ConnectionBadge integration={integration} />
            <div className="ml-auto flex items-center gap-1">
              <ConnectDialog integration={integration} />
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
                    <li key={connection.address} className="min-w-0">
                      <Item size="sm">
                        <ItemContent>
                          <ItemTitle className="flex-wrap">
                            <span>{connection.name}</span>
                            <Badge variant="outline">{connection.owner}</Badge>
                            <Badge variant="secondary">{connection.template}</Badge>
                          </ItemTitle>
                          <ItemDescription className="flex flex-wrap items-center gap-2">
                            {connection.identityLabel === undefined
                                || connection.identityLabel === null
                              ? null
                              : <span>{connection.identityLabel}</span>}
                            <span>{expiry(connection)}</span>
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => disconnect.mutate(connection)}
                            disabled={disconnect.isPending}
                          >
                            <Unplug className="size-3" />
                            Disconnect
                          </Button>
                        </ItemActions>
                      </Item>
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

