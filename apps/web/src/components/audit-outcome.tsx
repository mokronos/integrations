import { Badge } from "@/components/ui/badge"
import type { AuditOutcome } from "@mokronos/integrations-contracts"

const outcomes = {
  succeeded: { label: "Succeeded", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
  denied: { label: "Denied", variant: "destructive" },
  pending: { label: "Approval requested", variant: "default" }
} as const satisfies Readonly<Record<AuditOutcome, { readonly label: string; readonly variant: "default" | "secondary" | "destructive" }>>

export function AuditOutcomeBadge({ outcome }: { readonly outcome: AuditOutcome }) {
  const display = outcomes[outcome]
  return <Badge variant={display.variant}>{display.label}</Badge>
}
