import { Trash2 } from "lucide-react"
import { useState } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

export function ConfirmButton({ label, title, description, confirmLabel, pendingLabel, onConfirm, pending, blocked = false, children }: {
  readonly label: string
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  readonly pendingLabel: string
  readonly onConfirm: () => Promise<void>
  readonly pending: boolean
  readonly blocked?: boolean
  readonly children?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" className="text-destructive hover:text-destructive" />}>
        <Trash2 className="size-3" />
        {label}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{blocked ? "Close" : "Keep it"}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || blocked}
            onClick={(event) => {
              event.preventDefault()
              void onConfirm().then(() => setOpen(false), () => undefined)
            }}
          >
            {pending ? pendingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
