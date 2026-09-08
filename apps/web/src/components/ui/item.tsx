import type * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

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

export function ItemDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-description"
      className={cn("text-muted-foreground min-w-0 text-xs", className)}
      {...props}
    />
  )
}

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
