import { type IntegrationSearchKind, type IntegrationSearchMatch, whenPresent } from "@mokronos/integrations-contracts"
import { Download, Search, X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { OperationError } from "@/components/integrations/operation-feedback"
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
import { Select } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import * as gateway from "@/lib/gateway"
import { keys, useInvalidate, useMutation, useQuery } from "@/lib/queries"
import { decodeIntegrationSearchFilter } from "@/lib/schemas"

const ALL_KINDS = "__all__"
const kindOptions = [
  { value: ALL_KINDS, label: "All types" },
  { value: "mcp", label: "MCP" },
  { value: "openapi", label: "OpenAPI" }
] as const

type KindFilter = IntegrationSearchKind | typeof ALL_KINDS

const installableSurfaces = (result: IntegrationSearchMatch, kind: KindFilter) =>
  result.surfaces.filter((surface) =>
    surface.url !== undefined
    && (surface.type === "mcp" || surface.type === "openapi")
    && (kind === ALL_KINDS || surface.type === kind)
  )

const matches = (result: IntegrationSearchMatch, query: string): boolean =>
  `${result.name} ${result.domain} ${result.description}`.toLowerCase().includes(query)

function RegistryCard({
  result,
  kind,
  installing,
  install
}: {
  readonly result: IntegrationSearchMatch
  readonly kind: KindFilter
  readonly installing: string | undefined
  readonly install: (url: string) => void
}) {
  const surfaces = installableSurfaces(result, kind)
  const kinds = [...new Set(surfaces.map((surface) => surface.type))]
  const labels = result.domain.split(".")
  const name = result.name === result.domain && labels.length === 2
    ? labels[0]?.replace(/^./, (first) => first.toUpperCase()) ?? result.name
    : result.name

  return (
    <article className="flex min-h-56 min-w-0 flex-col rounded-xl border bg-card p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/50">
          <IntegrationIcon host={result.domain} size={28} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium" title={result.name}>{name}</h3>
          <p className="text-muted-foreground truncate text-xs" title={result.domain}>{result.domain}</p>
        </div>
      </div>
      <p className="text-muted-foreground mt-3 line-clamp-2 min-h-10 text-sm">{result.description}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {kinds.map((value) => <Badge key={value} variant="outline">{value === "mcp" ? "MCP" : "OpenAPI"}</Badge>)}
      </div>
      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        {surfaces.map((surface) => (
          <Button
            key={`${surface.type}-${surface.slug}`}
            size="sm"
            variant="outline"
            disabled={installing !== undefined}
            onClick={() => install(surface.url ?? "")}
            className="min-w-0"
          >
            <Download className="size-3" />
            <span className="truncate">{installing === surface.url ? "Installing…" : `Install ${surface.name}`}</span>
          </Button>
        ))}
      </div>
    </article>
  )
}

function RegistrySkeleton() {
  return Array.from({ length: 9 }, (_, index) => (
    <div key={index} className="flex min-h-56 flex-col rounded-xl border p-4" aria-hidden>
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 shrink-0" />
        <div className="flex-1 space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/2" /></div>
      </div>
      <Skeleton className="mt-4 h-4 w-full" />
      <Skeleton className="mt-2 h-4 w-4/5" />
      <Skeleton className="mt-auto h-8 w-28" />
    </div>
  ))
}

export function RegistrySearchDialog({ onInstalled }: { readonly onInstalled?: (slug: string) => void }) {
  const invalidate = useInvalidate()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [searchTerm, setSearchTerm] = useState("")
  const [kind, setKind] = useState<KindFilter>(ALL_KINDS)
  const [installing, setInstalling] = useState<string | undefined>()
  const trimmedQuery = query.trim().toLowerCase()

  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(trimmedQuery), 300)
    return () => clearTimeout(timer)
  }, [trimmedQuery])

  const browse = useQuery({
    queryKey: ["registry", "browse"],
    queryFn: () => gateway.searchRegistry({ query: "", limit: 100 }),
    enabled: open,
    staleTime: 5 * 60_000
  })
  const search = useQuery({
    queryKey: ["registry", "search", searchTerm, kind],
    queryFn: () => gateway.searchRegistry({
      query: searchTerm,
      ...whenPresent("kind", kind === ALL_KINDS ? undefined : kind),
      limit: 100
    }),
    enabled: open && searchTerm.length > 0,
    staleTime: 5 * 60_000
  })

  const results = useMemo(() => {
    const local = (browse.data?.results ?? []).filter((result) =>
      installableSurfaces(result, kind).length > 0
      && (trimmedQuery.length === 0 || matches(result, trimmedQuery))
    )
    if (trimmedQuery.length === 0 || searchTerm !== trimmedQuery || search.data === undefined) return local
    const found = search.data.results.filter((result) => installableSurfaces(result, kind).length > 0)
    const domains = new Set(found.map((result) => result.domain))
    return [...found, ...local.filter((result) => !domains.has(result.domain))]
  }, [browse.data, search.data, searchTerm, kind, trimmedQuery])

  const install = useMutation({
    mutationFn: (url: string) => {
      setInstalling(url)
      return gateway.discoverIntegration({ url })
    },
    onSuccess: (result) => {
      invalidate(keys.integrations, keys.connections)
      toast.success(`Installed ${result.integration.name}`, {
        description: result.requiresAuthentication
          ? `${result.authMethods.length} authentication ${result.authMethods.length === 1 ? "option" : "options"} found. Choose one to connect.`
          : `Connected with no credential; ${result.tools.length} tools available.`
      })
      setOpen(false)
      if (onInstalled === undefined) void navigate(`/integrations/${result.integration.slug}`)
      else onInstalled(result.integration.slug)
    },
    onSettled: () => setInstalling(undefined)
  })

  const loading = browse.isPending && trimmedQuery.length === 0
    || trimmedQuery.length > 0 && results.length === 0 && (browse.isPending || search.isPending || searchTerm !== trimmedQuery)
  const error = trimmedQuery.length === 0 ? browse.error : searchTerm === trimmedQuery ? search.error : null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Search className="size-4" /> Find integration
      </DialogTrigger>
      <DialogContent className="flex h-[min(48rem,calc(100dvh-2rem))] min-h-0 flex-col sm:max-w-4xl">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>Find an integration</DialogTitle>
          <DialogDescription>
            Browse available integrations or search by service, domain, or capability.
          </DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="text-muted-foreground absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
            <Input
              aria-label="Search integrations"
              className="pl-8 pr-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search integrations…"
            />
            {query.length > 0 ? (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2 p-1">
                <X className="size-4" />
              </button>
            ) : null}
          </div>
          <Select
            className="w-full sm:w-36"
            value={kind}
            onValueChange={(value) => setKind(decodeIntegrationSearchFilter(value))}
            items={kindOptions}
          />
        </div>
        {error === null ? null : <OperationError title="Registry search failed" step="Loading integrations.sh" error={error} />}
        {install.error === null ? null : <OperationError title="Installation failed" step="Inspecting and installing the selected endpoint" error={install.error} />}
        <p className="text-muted-foreground shrink-0 text-xs" aria-live="polite">
          {loading ? "Loading integrations…" : `Showing ${results.length} ${results.length === 1 ? "integration" : "integrations"}${trimmedQuery.length === 0 ? " · Search to find more" : ""}`}
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {loading || results.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {loading ? <RegistrySkeleton /> : results.map((result) => (
                <RegistryCard key={result.domain} result={result} kind={kind} installing={installing} install={(url) => install.mutate(url)} />
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground flex min-h-56 items-center justify-center rounded-xl border border-dashed px-4 text-center text-sm">
              {error === null ? "No matching integrations. Try another search or type." : "Could not load integrations. Try again shortly."}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
