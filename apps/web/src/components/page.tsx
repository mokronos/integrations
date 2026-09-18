import { useState, type ReactNode } from "react"
import { AlertTriangle, Check, RefreshCw } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export function Page({
  title,
  description,
  actions,
  children
}: {
  readonly title: ReactNode
  readonly description?: string
  readonly actions?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 sm:gap-6 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">{title}</h1>
          {description === undefined
            ? null
            : <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
        {actions === undefined ? null : <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  )
}

export function ReloadButton({ onClick }: { readonly onClick: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle")
  const refresh = () => {
    setState("busy")
    void onClick().finally(() => {
      setState("done")
      setTimeout(() => setState("idle"), 1200)
    })
  }
  return (
    <Button variant="outline" size="icon" onClick={refresh} disabled={state !== "idle"} aria-label="Refresh">
      {state === "done"
        ? <Check className="size-4 animate-in fade-in zoom-in-50 duration-200" />
        : <RefreshCw className={cn("size-4", state === "busy" && "animate-spin")} />}
    </Button>
  )
}

export function QueryError({ error }: { readonly error: Error | null | undefined }) {
  if (error === null || error === undefined) return null
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>The gateway refused that</AlertTitle>
      <AlertDescription>
        {error.message}
      </AlertDescription>
    </Alert>
  )
}

export function LoadingRows({ rows = 4 }: { readonly rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}
    </div>
  )
}
