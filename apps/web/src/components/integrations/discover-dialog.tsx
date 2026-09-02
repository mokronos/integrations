import { whenPresentMap } from "@mokronos/contracts"
import { useState } from "react"
import { toast } from "sonner"

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
/** Discovery is the only way an integration enters the catalog, and it is a
 *  privileged act — it installs whatever the URL turns out to be. */
export function DiscoverDialog() {
  const invalidate = useInvalidate()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [connection, setConnection] = useState("default")
  const [slug, setSlug] = useState("")
  const [name, setName] = useState("")

  const discover = useMutation({
    mutationFn: () =>
      gateway.discoverIntegration({
        url,
        ...whenPresentMap("connection", connection.trim() || undefined, (value) => value),
        ...whenPresentMap("slug", slug.trim() || undefined, (value) => value),
        ...whenPresentMap("name", name.trim() || undefined, (value) => value)
      }),
    onSuccess: (result) => {
      invalidate(keys.integrations, keys.connections)
      toast.success(`Installed ${result.integration.name}`, {
        description: `${result.tools.length} tools discovered`
      })
      setOpen(false)
      setUrl("")
      setSlug("")
      setName("")
    },
    onError: (error: Error) => toast.error("Discovery failed", { description: error.message })
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Discover</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Discover an integration</DialogTitle>
          <DialogDescription>
            Point the gateway at an MCP endpoint or an OpenAPI document. It
            inspects the URL, installs what it finds, and opens a connection.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="discover-url">Endpoint</Label>
            <Input
              id="discover-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/mcp"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="discover-connection">Connection name</Label>
            <Input
              id="discover-connection"
              value={connection}
              onChange={(event) => setConnection(event.target.value)}
              placeholder="default"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="discover-name">Name</Label>
              <Input
                id="discover-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="derived from the endpoint"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discover-slug">Slug</Label>
              <Input
                id="discover-slug"
                className="font-mono"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="derived from the name"
              />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            Both are guessed from the endpoint when left blank. The name can be
            changed later; the slug cannot — it is what every tool address and
            alias is made of.
          </p>
        </div>
        <DialogFooter>
          <Button
            onClick={() => discover.mutate()}
            disabled={url.trim().length === 0 || discover.isPending}
          >
            {discover.isPending ? "Discovering…" : "Discover"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
