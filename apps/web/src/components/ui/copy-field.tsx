import { Check, Copy } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function CopyField({ value, label, multiline = false, className }: {
  readonly value: string
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
