import type * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/** One row, one affordance.
 *
 * Everything in this dashboard that a person can click and that is bigger than
 * a button is this component: an integration in the sidebar, a connection, a
 * tool, a field in a schema. They share a hover, a focus ring, and a pressed
 * state, so "is this clickable?" is answered by looking rather than by trying.
 *
 * `asChild` is what makes the whole row the target. The row *becomes* the link
 * or the button instead of wrapping one, so the padding, the icon, and the
 * empty space to the right of the text all belong to the same click — which is
 * what a pointer heading for a row expects, and what a screen reader announces
 * as one control rather than a paragraph containing a small link. */
const itemVariants = cva(
  "group/item relative flex w-full min-w-0 items-center gap-3 rounded-lg border text-left text-sm transition-colors outline-none",
  {
    variants: {
      variant: {
        outline: "border-border",
        plain: "border-transparent"
      },
      size: {
        default: "px-3 py-2.5",
        sm: "px-2.5 py-2"
      },
      interactive: {
        true:
          "cursor-pointer select-none hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px aria-expanded:bg-accent/30 data-[active=true]:border-primary data-[active=true]:bg-accent/50",
        false: ""
      }
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
      interactive: false
    }
  }
)

export function Item({
  className,
  variant,
  size,
  interactive,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof itemVariants> & {
  readonly asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : "div"
  return (
    <Comp
      data-slot="item"
      className={cn(itemVariants({ variant, size, interactive, className }))}
      {...props}
    />
  )
}

/** The icon, avatar, or chevron a row leads with. Never the click target
 *  itself — the row already is one. */
export function ItemMedia({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="item-media"
      className={cn(
        "text-muted-foreground flex shrink-0 items-center justify-center [&_svg]:pointer-events-none",
        className
      )}
      {...props}
    />
  )
}

/** The text column. `min-w-0` so a long tool address truncates instead of
 *  pushing the actions off the row. */
export function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-content"
      className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)}
      {...props}
    />
  )
}

export function ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-title"
      className={cn("flex min-w-0 items-center gap-2 font-medium", className)}
      {...props}
    />
  )
}

/** The second line of a row.
 *
 * Deliberately a block, not a flex row: `truncate` and `line-clamp-*` both work
 * by setting `display`, and a base that sets its own would silently win over
 * them. Callers that want inline parts ask for `flex` themselves. */
export function ItemDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-description"
      className={cn("text-muted-foreground min-w-0 text-xs", className)}
      {...props}
    />
  )
}

/** Controls that do their own thing on a row that is itself clickable.
 *
 * `relative` lifts them above a stretched link, and the stopped propagation
 * keeps a disconnect from also navigating. A row with actions is still one
 * click target for the row's own purpose; these are the exceptions to it. */
export function ItemActions({ className, onClick, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-actions"
      className={cn("relative z-10 flex shrink-0 items-center gap-1", className)}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.(event)
      }}
      {...props}
    />
  )
}
