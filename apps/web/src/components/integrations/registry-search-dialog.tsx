import { whenPresent } from "@mokronos/contracts"
import { Download, Search } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { IntegrationIcon } from "@/components/integrations/integration-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import * as gateway from "@/lib/gateway"
import { keys, useInvalidate, useMutation } from "@/lib/queries"
import {
  decodeIntegrationSearchFilter
} from "@/lib/schemas"
import type { IntegrationSearchKind, IntegrationSearchMatch } from "@mokronos/contracts"
const ALL_KINDS = "__all__"

/** Search is deliberately next to discovery: the registry finds an exact
 * installable endpoint, then the existing provisioning path owns installation. */
export function RegistrySearchDialog() {
  const invalidate = useInvalidate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState<IntegrationSearchKind | typeof ALL_KINDS>(ALL_KINDS)
  const [results, setResults] = useState<ReadonlyArray<IntegrationSearchMatch>>([])
  const [installing, setInstalling] = useState<string | undefined>()

  const search = useMutation({
    mutationFn: () => gateway.searchRegistry({
      query: query.trim(),
      ...whenPresent("kind", kind === ALL_KINDS ? undefined : kind),
      limit: 12
    }),
    onSuccess: (response) => setResults(response.results),
    onError: (error: Error) => toast.error("Search failed", { description: error.message })
  })

  const install = useMutation({
    mutationFn: (url: string) => {
      setInstalling(url)
      return gateway.discoverIntegration({ url })
    },
    onSuccess: (result) => {
      invalidate(keys.integrations, keys.connections)
      toast.success(`Installed ${result.integration.name}`, {
        description: `${result.tools.length} tools discovered`
      })
      setOpen(false)
    },
    onError: (error: Error) => toast.error("Installation failed", { description: error.message }),
    onSettled: () => setInstalling(undefined)
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Search className="size-4" /> Find integration</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Find an integration</DialogTitle>
          <DialogDescription>
            Search integrations.sh by service, domain, or capability, then install an exact MCP or OpenAPI endpoint.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (query.trim().length > 0) search.mutate()
          }}
        >
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
            <Input
              className="pl-8"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Slack, github.com, issue tracking…"
            />
          </div>
          <Select
            value={kind}
            onValueChange={(value) => setKind(decodeIntegrationSearchFilter(value))}
          >
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_KINDS}>Any kind</SelectItem>
              <SelectItem value="mcp">MCP</SelectItem>
              <SelectItem value="openapi">OpenAPI</SelectItem>
              <SelectItem value="graphql">GraphQL</SelectItem>
              <SelectItem value="cli">CLI</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" disabled={query.trim().length === 0 || search.isPending}>
            {search.isPending ? "Searching…" : "Search"}
          </Button>
        </form>

        <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
          {!search.isPending && results.length === 0
            ? (
              <div className="text-muted-foreground rounded-lg border border-dashed px-4 py-10 text-center text-sm">
                {search.isSuccess ? "No matching integrations." : "Search the public registry to begin."}
              </div>
            )
            : results.map((result) => {
              const installable = result.surfaces.filter(
                (surface) => surface.url !== undefined
              )
              const kinds = [...new Set(result.surfaces.map((surface) => surface.type))]
              return (
                <div key={result.domain} className="space-y-3 rounded-lg border p-3">
                  <div className="flex items-start gap-3">
                    <IntegrationIcon host={result.domain} size={20} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{result.name}</span>
                        {kinds.map((value) => <Badge key={value} variant="outline">{value}</Badge>)}
                      </div>
                      <p className="text-muted-foreground mt-1 text-sm">{result.description}</p>
                      <p className="text-muted-foreground mt-1 text-xs">{result.domain}</p>
                    </div>
                  </div>
                  {installable.length === 0
                    ? <p className="text-muted-foreground text-xs">No browser-installable surface was published.</p>
                    : (
                      <div className="flex flex-wrap gap-2">
                        {installable.map((surface) => (
                          <Button
                            key={`${surface.type}-${surface.slug}`}
                            size="sm"
                            variant="outline"
                            onClick={() => install.mutate(surface.url ?? "")}
                            disabled={install.isPending}
                          >
                            <Download className="size-3" />
                            {installing === surface.url ? "Installing…" : `Install ${surface.name}`}
                          </Button>
                        ))}
                      </div>
                    )}
                </div>
              )
            })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Discovery is the only way an integration enters the catalog, and it is a
 *  privileged act — it installs whatever the URL turns out to be. */
