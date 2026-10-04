import { cn } from "@/lib/utils"

/** A row of mutually exclusive choices, all visible at once. */
export function Segmented<Value extends string>({ value, options, onChange, label, disabled = false, className }: {
  readonly value: Value | undefined
  readonly options: ReadonlyArray<{ readonly value: Value; readonly label: string; readonly title?: string }>
  readonly onChange: (value: Value) => void
  readonly label: string
  readonly disabled?: boolean
  readonly className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("bg-muted inline-flex shrink-0 rounded-md p-0.5", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
            value === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
