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
          "bg-background block min-w-0 rounded border pr-10 pl-2 font-mono text-xs",
          multiline ? "whitespace-pre overflow-x-auto py-2.25" : "flex min-h-9 items-center break-all py-1"
        )}
      >
        {value}
      </code>
      <CopyButton
        value={value}
        label={label}
        className={multiline ? copyButtonOverlay : "absolute inset-y-0 right-1 my-auto"}
      />
    </div>
  )
}
