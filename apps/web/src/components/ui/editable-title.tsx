import { Check, Pencil, X } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function EditableTitle({ value, onSave, saving, disabled = false }: {
  readonly value: string
  readonly onSave: (name: string) => void
  readonly saving: boolean
  readonly disabled?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  if (!editing) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span>{value}</span>
        {disabled ? null : (
          <Button variant="ghost" size="sm" aria-label="Rename" onClick={() => { setDraft(value); setEditing(true) }}>
            <Pencil className="size-3" />
          </Button>
        )}
      </span>
    )
  }

  return (
    <form
      className="flex min-w-0 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (draft.trim().length > 0) { onSave(draft.trim()); setEditing(false) }
      }}
    >
      <Input
        autoFocus
        className="h-9 w-64 text-lg font-semibold"
        value={draft}
        aria-label="Name"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") setEditing(false) }}
      />
      <Button type="submit" variant="ghost" size="sm" aria-label="Save name" disabled={saving || draft.trim().length === 0}>
        <Check className="size-3" />
      </Button>
      <Button type="button" variant="ghost" size="sm" aria-label="Cancel rename" onClick={() => setEditing(false)}>
        <X className="size-3" />
      </Button>
    </form>
  )
}
