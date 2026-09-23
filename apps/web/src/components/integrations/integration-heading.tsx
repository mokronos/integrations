import { ChevronRight } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"

import { IntegrationIcon, integrationHost } from "@/components/integrations/integration-icon"
import { Badge } from "@/components/ui/badge"
import { pluralise } from "@/lib/format"
import type { IntegrationOverview } from "@integragents/contracts"
import { cn } from "@/lib/utils"

export const useIntegrationCollapse = (integrationCount: number) => {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())
  return {
    isOpen: (slug: string) => toggled.has(slug) === integrationCount > 1,
    toggle: (slug: string) => setToggled((current) => {
      const next = new Set(current)
      if (next.has(slug)) next.delete(slug); else next.add(slug)
      return next
    })
  }
}

export function IntegrationHeading({
  slug,
  integration,
  toolCount,
  open,
  onToggle
}: {
  readonly slug: string
  readonly integration: IntegrationOverview | undefined
  readonly toolCount: number
  readonly open?: boolean
  readonly onToggle?: () => void
}) {
  const name = integration?.name ?? slug
  return (
    <div className="relative flex min-w-0 items-center gap-3">
      {onToggle === undefined ? null : <>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} ${name} tools`}
          onClick={onToggle}
          className="absolute inset-0 cursor-pointer rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        />
        <ChevronRight aria-hidden className={cn("text-muted-foreground pointer-events-none size-4 shrink-0 transition-transform", open && "rotate-90")} />
      </>}
      <div className="pointer-events-none flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/50">
        <IntegrationIcon host={integrationHost(integration ?? { slug })} size={28} />
      </div>
      <div className="pointer-events-none min-w-0 flex-1">
        {integration === undefined
          ? <h3 className="truncate font-medium">{slug}</h3>
          : <h3 className="truncate font-medium"><Link to={`/integrations/${slug}`} className="pointer-events-auto relative hover:underline">{integration.name}</Link></h3>}
        <p className="text-muted-foreground truncate text-xs">{slug}</p>
      </div>
      <Badge variant="outline" className="pointer-events-none">{pluralise(toolCount, "tool")}</Badge>
    </div>
  )
}
