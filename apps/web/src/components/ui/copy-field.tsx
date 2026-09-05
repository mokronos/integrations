import { Check, Copy } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** A value the operator has to move into another program, and the button that
 *  moves it.
 *
 *  Copying is the whole point of showing these, so the button is part of the
 *  field rather than something nearby: an endpoint URL, a redirect URI, a
 *  config block. The tick after a copy is the only feedback that says *this*
 *  field went to the clipboard — a toast alone cannot, when a card shows
 *  three of them. */
export function CopyField({ value, label, multiline = false, className }: {
  readonly value: string
  /** Named in the toast, so a copy from a card of several fields says which. */
  readonly label: string
  readonly multiline?: boolean
  readonly className?: string
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success(`${label} copied`)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(`Could not copy ${label.toLowerCase()}`, { description: "Select the text and copy it manually." })
    }
  }
  return (
    <div className={cn("flex gap-2", multiline ? "items-start" : "items-center", className)}>
      <code
        className={cn(
          "bg-background min-w-0 flex-1 rounded border px-2 py-1 font-mono text-xs",
          multiline ? "block whitespace-pre overflow-x-auto" : "truncate"
        )}
      >
        {value}
      </code>
      <Button variant="outline" size="sm" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}
