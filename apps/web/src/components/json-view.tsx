import { ChevronRight } from "lucide-react"
import { useState } from "react"
import type { Json } from "@mokronos/integrations-contracts"
import { isJsonObject } from "@mokronos/integrations-contracts"

import { Button } from "@/components/ui/button"
import { CopyButton, copyButtonOverlay } from "@/components/ui/copy-button"
import { pluralise } from "@/lib/format"
import { cn } from "@/lib/utils"

const tokenPattern = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

const highlight = (text: string): ReadonlyArray<React.ReactNode> => {
  const nodes: Array<React.ReactNode> = []
  let cursor = 0
  for (const match of text.matchAll(tokenPattern)) {
    const start = match.index
    if (start > cursor) nodes.push(text.slice(cursor, start))
    const [whole, string, colon, keyword, number] = match
    if (string !== undefined) {
      nodes.push(
        <span key={start} className={colon === undefined ? "text-syntax-string" : "text-syntax-key"}>
          {string}
        </span>
      )
      if (colon !== undefined) nodes.push(colon)
    } else if (keyword !== undefined) {
      nodes.push(<span key={start} className="text-syntax-keyword">{whole}</span>)
    } else if (number !== undefined) {
      nodes.push(<span key={start} className="text-syntax-number">{whole}</span>)
    }
    cursor = start + whole.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

const summarise = (value: Json): string => {
  if (isJsonObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) return "empty object"
    const shown = keys.slice(0, 4).join(", ")
    return `${pluralise(keys.length, "field")}: ${shown}${keys.length > 4 ? ", …" : ""}`
  }
  if (Array.isArray(value)) return value.length === 0 ? "empty list" : pluralise(value.length, "item")
  const text = JSON.stringify(value)
  return text.length > 64 ? `${text.slice(0, 64)}…` : text
}

export function JsonView({
  value,
  label,
  defaultOpen = false,
  className
}: {
  readonly value: Json
  readonly label: string
  readonly defaultOpen?: boolean
  readonly className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const text = JSON.stringify(value, null, 2)

  return (
    <div className={cn("space-y-1", className)}>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 max-w-full gap-1 px-1.5 font-mono text-xs"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground truncate font-normal">· {summarise(value)}</span>
      </Button>
      {open ? (
        <div className="relative">
          <pre className="bg-muted/60 max-h-96 overflow-auto rounded-md py-2.5 pr-10 pl-3 font-mono text-xs leading-relaxed">
            {highlight(text)}
          </pre>
          <CopyButton value={text} label={label} className={copyButtonOverlay} />
        </div>
      ) : null}
    </div>
  )
}
