import { Check, Copy } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"

export function CopyButton({ value, label, className }: {
  readonly value: string
  readonly label: string
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
    <Button variant="ghost" size="icon-sm" className={className} onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  )
}

export const copyButtonOverlay = "absolute top-1 right-1"
