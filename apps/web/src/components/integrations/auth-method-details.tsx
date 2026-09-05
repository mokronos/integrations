import { KeyRound, LockKeyhole, ShieldCheck, Unlock } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { AuthMethod } from "@/lib/schemas"
import { cn } from "@/lib/utils"

const kindDetails = {
  oauth: {
    label: "OAuth 2.0",
    description: "Sign in with the provider and grant the requested access.",
    icon: ShieldCheck
  },
  apikey: {
    label: "API key",
    description: "Paste a key issued by the provider.",
    icon: KeyRound
  },
  header: {
    label: "HTTP credential",
    description: "Send a token or credential in an HTTP header.",
    icon: LockKeyhole
  },
  none: {
    label: "No authentication",
    description: "This endpoint can be connected without a credential.",
    icon: Unlock
  }
} as const

const placementLabel = (method: AuthMethod): string | undefined => {
  const placements = method.placements ?? []
  if (placements.length === 0) return undefined
  return placements.map((placement) => {
    const carrier = placement.carrier === "header"
      ? "Header"
      : placement.carrier === "query" ? "Query parameter" : "Environment variable"
    const prefix = placement.prefix.length === 0
      ? ""
      : ` · ${placement.prefix.trim()} prefix`
    return `${carrier}: ${placement.name}${prefix}`
  }).join(" · ")
}

const oauthDetail = (method: AuthMethod): string | undefined => {
  if (method.kind !== "oauth") return undefined
  if (method.oauth?.supportsDynamicRegistration === true) {
    return "The gateway can register an OAuth client automatically."
  }
  return "You will need OAuth client details from the provider."
}

export function AuthMethodDetails({
  method,
  selected = false,
  onSelect
}: {
  readonly method: AuthMethod
  readonly selected?: boolean
  readonly onSelect?: ((template: string) => void) | undefined
}) {
  const details = kindDetails[method.kind]
  const Icon = details.icon
  const placement = placementLabel(method)
  const oauth = oauthDetail(method)
  const scopes = method.oauth?.scopes ?? []
  const content = (
    <>
      <div className="flex items-start gap-3">
        <div className="bg-muted mt-0.5 rounded-md p-1.5">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{method.label}</span>
            <Badge variant="outline">{details.label}</Badge>
            {selected ? <Badge>selected</Badge> : null}
          </div>
          <p className="text-muted-foreground text-xs">{details.description}</p>
          {placement === undefined
            ? null
            : <p className="text-muted-foreground font-mono text-xs">{placement}</p>}
          {oauth === undefined
            ? null
            : <p className="text-muted-foreground text-xs">{oauth}</p>}
        </div>
      </div>
      {scopes.length === 0
        ? null
        : (
          <div className="flex flex-wrap gap-1 pl-10">
            <span className="text-muted-foreground mr-1 text-xs">Scopes</span>
            {scopes.map((scope) => <Badge key={scope} variant="secondary">{scope}</Badge>)}
          </div>
        )}
    </>
  )

  if (onSelect === undefined) {
    return <div className="space-y-2 rounded-lg border p-3">{content}</div>
  }
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={cn(
        "w-full space-y-2 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50",
        selected && "border-foreground bg-muted/40 ring-1 ring-foreground/20"
      )}
      onClick={() => onSelect(method.template)}
    >
      {content}
    </button>
  )
}
