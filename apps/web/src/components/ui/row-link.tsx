import type * as React from "react"
import { Link } from "react-router"

import { cn } from "@/lib/utils"

export const rowNavigates = "relative cursor-pointer"

export function RowLink({ className, ...props }: React.ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        "font-medium after:absolute after:inset-0 after:content-['']",
        "hover:underline focus-visible:outline-none",
        "focus-visible:after:outline-ring focus-visible:after:-outline-offset-2 focus-visible:after:outline-2",
        className
      )}
      {...props}
    />
  )
}
