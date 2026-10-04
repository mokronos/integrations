import { Option } from "effect"
import { Pencil, X } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { parseJsonString, type ApprovalRule, type ArgumentPath, type Json, type ProfileId } from "@integragents/contracts"

import { JsonView } from "@/components/json-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmButton } from "@/components/ui/confirm-button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { pinnedObject } from "@/lib/approval-groups"
import { when } from "@/lib/format"
import * as gateway from "@/lib/gateway"
import { keys, useInvalidate, useMutation } from "@/lib/queries"

const pathLabel = (path: ArgumentPath): string => path.length === 0 ? "arguments" : path.join(".")

type Field = { readonly path: ArgumentPath; readonly open: boolean; readonly text: string }

const fieldsOf = (rule: ApprovalRule): ReadonlyArray<Field> => [
  ...rule.pinned.map((entry) => ({ path: entry.path, open: false, text: JSON.stringify(entry.value) })),
  ...rule.free.map((path) => ({ path, open: true, text: "" }))
]

function EditRule({ rule, profileId }: { readonly rule: ApprovalRule; readonly profileId: ProfileId }) {
  const invalidate = useInvalidate()
  const [open, setOpen] = useState(false)
  const [fields, setFields] = useState(() => fieldsOf(rule))
  const values = fields.map((field) => field.open ? Option.some<Json>(null) : parseJsonString(field.text))
  const invalid = values.some(Option.isNone)
  const save = useMutation({
    mutationFn: () => gateway.updateApprovalRule(rule.id, {
      pinned: fields.flatMap((field, index) => {
        const value = values[index]
        return field.open || value === undefined || Option.isNone(value) ? [] : [{ path: field.path, value: value.value }]
      }),
      free: fields.filter((field) => field.open).map((field) => field.path)
    }),
    onSuccess: () => {
      invalidate(keys.approvalRules(profileId))
      setOpen(false)
      toast.success("Saved approval updated")
    },
    onError: (error: Error) => toast.error("Could not update the saved approval", { description: error.message })
  })
  const update = (index: number, change: Partial<Field>) =>
    setFields((current) => current.map((field, at) => at === index ? { ...field, ...change } : field))

  return <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setFields(fieldsOf(rule)) }}>
    <DialogTrigger render={<Button size="sm" variant="ghost" />}><Pencil className="size-3" />Edit</DialogTrigger>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Edit saved approval</DialogTitle>
        <DialogDescription>
          A call runs without asking only when every pinned field holds exactly its value, open fields hold anything, and it sends no other field.
        </DialogDescription>
      </DialogHeader>
      <div className="max-h-96 space-y-2 overflow-auto">
        {fields.map((field, index) => <div key={pathLabel(field.path)} className="flex items-center gap-2 rounded-md border p-2">
          <code className="w-32 shrink-0 truncate font-mono text-xs" title={pathLabel(field.path)}>{pathLabel(field.path)}</code>
          <label className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
            <Switch checked={field.open} onCheckedChange={(checked) => update(index, { open: checked })} />
            any value
          </label>
          {field.open ? <span className="flex-1" /> : <Input
            className="flex-1 font-mono text-xs"
            value={field.text}
            aria-label={`Value of ${pathLabel(field.path)} as JSON`}
            aria-invalid={Option.isNone(values[index] ?? Option.none())}
            onChange={(event) => update(index, { text: event.target.value })}
          />}
          <Button size="icon-sm" variant="ghost" aria-label={`Remove ${pathLabel(field.path)}`} onClick={() => setFields((current) => current.filter((_, at) => at !== index))}>
            <X className="size-3" />
          </Button>
        </div>)}
        {fields.length === 0 ? <p className="text-muted-foreground text-xs">No fields left: only a call with empty arguments would match.</p> : null}
      </div>
      <DialogFooter>
        <Button onClick={() => save.mutate()} disabled={invalid || save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function SavedApproval({ rule, profileId }: { readonly rule: ApprovalRule; readonly profileId: ProfileId }) {
  const invalidate = useInvalidate()
  const remove = useMutation({
    mutationFn: () => gateway.deleteApprovalRule(rule.id),
    onSuccess: () => { invalidate(keys.approvalRules(profileId)); toast.success("Saved approval deleted") },
    onError: (error: Error) => toast.error("Could not delete the saved approval", { description: error.message })
  })
  return <div className="space-y-2 rounded-md border p-2">
    <JsonView value={pinnedObject(rule.pinned)} label="must equal" defaultOpen />
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-xs">any value:</span>
      {rule.free.length === 0
        ? <span className="text-muted-foreground text-xs">nothing, only this exact call</span>
        : rule.free.map((path) => <Badge key={pathLabel(path)} variant="outline" className="font-mono">{pathLabel(path)}</Badge>)}
      <span className="text-muted-foreground ml-auto text-xs">
        saved {when(rule.createdAt)}{rule.createdBy === null ? "" : ` by ${rule.createdBy}`}
      </span>
      <EditRule rule={rule} profileId={profileId} />
      <ConfirmButton
        label="Delete"
        title="Delete this saved approval?"
        description="Calls it covered will ask again."
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        pending={remove.isPending}
        onConfirm={() => remove.mutateAsync().then(() => undefined)}
      />
    </div>
  </div>
}
