import { whenPresentMap } from "@mokronos/contracts"
import { Check, Circle, LoaderCircle } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router"

import { AuthMethodDetails } from "@/components/integrations/auth-method-details"
import { OperationError } from "@/components/integrations/operation-feedback"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import * as gateway from "@/lib/gateway"
import { keys, useInvalidate, useMutation } from "@/lib/queries"

const discoverySteps = [
  "Reach the endpoint",
  "Identify MCP or OpenAPI",
  "Inspect supported authentication",
  "Install the integration",
  "Open a connection when no credential is required"
] as const

function DiscoveryProgress() {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center gap-2 font-medium">
        <LoaderCircle className="size-4 animate-spin" />
        Inspecting endpoint
      </div>
      <ol className="space-y-1.5 text-xs">
        {discoverySteps.map((step, index) => (
          <li key={step} className="text-muted-foreground flex items-center gap-2">
            {index === 0
              ? <LoaderCircle className="size-3 animate-spin" />
              : <Circle className="size-3" />}
            {step}
          </li>
        ))}
      </ol>
      <p className="text-muted-foreground text-xs">
        The gateway performs these checks as one operation. Completed details appear here when it responds.
      </p>
    </div>
  )
}

function DiscoveryResult({
  result,
  connection
}: {
  readonly result: Awaited<ReturnType<typeof gateway.discoverIntegration>>
  readonly connection: string
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Check className="size-4" />
          <span className="font-medium">{result.integration.name} installed</span>
          <Badge variant="outline">{result.classification.kind === "mcp" ? "MCP" : "OpenAPI"}</Badge>
        </div>
        <ol className="text-muted-foreground mt-3 space-y-1.5 text-xs">
          <li className="flex gap-2"><Check className="size-3 shrink-0" />Endpoint reached and identified as {result.classification.kind === "mcp" ? "MCP" : "OpenAPI"}.</li>
          <li className="flex gap-2"><Check className="size-3 shrink-0" />Authentication inspected: {result.authMethods.length} {result.authMethods.length === 1 ? "option" : "options"} found.</li>
          <li className="flex gap-2"><Check className="size-3 shrink-0" />Integration installed as <code>{result.integration.slug}</code>.</li>
          <li className="flex gap-2">
            {result.requiresAuthentication
              ? <Circle className="size-3 shrink-0" />
              : <Check className="size-3 shrink-0" />}
            {result.requiresAuthentication
              ? "Connection not opened: choose an authentication option next."
              : `Connected as ${connection.trim() || "default"}; no credential was required.`}
          </li>
        </ol>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide">Available authentication</p>
        {result.authMethods.map((method) => (
          <AuthMethodDetails key={method.id} method={method} />
        ))}
      </div>

      <p className="text-muted-foreground text-xs">
        {result.tools.length} {result.tools.length === 1 ? "tool is" : "tools are"} available now.
        {result.requiresAuthentication ? " More may appear after connecting." : ""}
      </p>
    </div>
  )
}

export function DiscoverDialog() {
  const invalidate = useInvalidate()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [connection, setConnection] = useState("default")
  const [slug, setSlug] = useState("")
  const [name, setName] = useState("")

  const discover = useMutation({
    mutationFn: () => gateway.discoverIntegration({
      url: url.trim(),
      ...whenPresentMap("connection", connection.trim() || undefined, (value) => value),
      ...whenPresentMap("slug", slug.trim() || undefined, (value) => value),
      ...whenPresentMap("name", name.trim() || undefined, (value) => value)
    }),
    onSettled: () => invalidate(keys.integrations, keys.connections)
  })

  const reset = () => {
    discover.reset()
    setUrl("")
    setConnection("default")
    setSlug("")
    setName("")
  }

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) reset()
  }

  const result = discover.data
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button>Discover endpoint</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{result === undefined ? "Discover an integration" : "Discovery complete"}</DialogTitle>
          <DialogDescription>
            {result === undefined
              ? "Give the gateway an MCP endpoint or OpenAPI document. It identifies the protocol, inspects authentication, and installs the result."
              : "The endpoint was inspected successfully. Review what was installed and how it can be connected."}
          </DialogDescription>
        </DialogHeader>

        {result === undefined
          ? (
            <div className="space-y-4">
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="discover-url">MCP endpoint or OpenAPI document URL</Label>
                  <Input id="discover-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" disabled={discover.isPending} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="discover-connection">Connection name</Label>
                  <Input id="discover-connection" value={connection} onChange={(event) => setConnection(event.target.value)} placeholder="default" disabled={discover.isPending} />
                  <p className="text-muted-foreground text-xs">
                    Used immediately only when the endpoint needs no credential. Otherwise you choose auth after discovery.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="discover-name">Display name <span className="text-muted-foreground">(optional)</span></Label>
                    <Input id="discover-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Derived from endpoint" disabled={discover.isPending} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="discover-slug">Slug <span className="text-muted-foreground">(optional)</span></Label>
                    <Input id="discover-slug" className="font-mono" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="Derived from name" disabled={discover.isPending} />
                  </div>
                </div>
                <p className="text-muted-foreground text-xs">
                  The display name can change later. The slug cannot because it identifies tools and connections.
                </p>
              </div>

              {discover.isPending ? <DiscoveryProgress /> : null}
              {discover.error === null ? null : (
                <OperationError title="Discovery failed" step="Endpoint inspection and installation" error={discover.error} />
              )}
            </div>
          )
          : <DiscoveryResult result={result} connection={connection} />}

        <DialogFooter>
          {result === undefined
            ? (
              <Button onClick={() => discover.mutate()} disabled={url.trim().length === 0 || discover.isPending}>
                {discover.isPending ? "Inspecting and installing…" : "Inspect endpoint"}
              </Button>
            )
            : (
              <>
                <Button variant="outline" onClick={() => changeOpen(false)}>Close</Button>
                <Button onClick={() => {
                  const installedSlug = result.integration.slug
                  changeOpen(false)
                  void navigate(`/integrations/${installedSlug}`)
                }}>
                  {result.requiresAuthentication ? "Choose authentication" : "View integration"}
                </Button>
              </>
            )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
