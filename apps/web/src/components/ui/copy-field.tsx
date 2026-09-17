import { CopyButton, copyButtonOverlay } from "@/components/ui/copy-button"
import { cn } from "@/lib/utils"

export function CopyField({ value, label, multiline = false, className }: {
  readonly value: string
  readonly label: string
  readonly multiline?: boolean
  readonly className?: string
}) {
  return (
    <div className={cn("relative", className)}>
      <code
        className={cn(
          "bg-background block min-w-0 rounded border py-1.5 pr-10 pl-2 font-mono text-xs",
          multiline ? "whitespace-pre overflow-x-auto" : "break-all"
        )}
      >
        {value}
      </code>
      <CopyButton value={value} label={label} className={copyButtonOverlay} />
    </div>
  )
}
