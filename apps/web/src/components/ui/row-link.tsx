import type * as React from "react"
import { Link } from "react-router"

import { cn } from "@/lib/utils"

/** What a container adds to become one click target, next to {@link RowLink}. */
export const rowNavigates = "relative cursor-pointer"

/** A link that covers the whole row it sits in.
 *
 * A table row that leads to one page should be clickable across its width; the
 * name being the only live target is a game of pixel-hunting, and the rest of
 * the row looks inert while behaving inert. This keeps a real anchor — the
 * status bar shows the destination, middle-click opens a tab, copy-link works,
 * and the keyboard reaches it in order — and stretches only its hit area, with
 * the focus ring drawn on the stretched box so tabbing marks the whole row.
 *
 * Anything else interactive in the row has to sit above it: give that cell
 * `relative z-10` (which is what `ItemActions` does for non-table rows). */
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
