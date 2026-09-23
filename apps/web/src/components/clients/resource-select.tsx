import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"

export type AssignableResource<Id extends string> = { readonly id: Id; readonly name: string; readonly isDefault: boolean }

export const defaultResourceId = <Id extends string>(resources: ReadonlyArray<AssignableResource<Id>>) =>
  resources.find((resource) => resource.isDefault)?.id

export function ResourceSelect<Id extends string>({ label, value, onChange, resources }: {
  readonly label: string
  readonly value: Id | undefined
  readonly onChange: (id: Id) => void
  readonly resources: ReadonlyArray<AssignableResource<Id>>
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select
        className="w-full"
        value={value ?? ""}
        onValueChange={(next) => {
          const chosen = resources.find((resource) => resource.id === next)
          if (chosen !== undefined) onChange(chosen.id)
        }}
        items={resources.map((resource) => ({ value: resource.id, label: resource.isDefault ? `${resource.name} (default)` : resource.name }))}
      />
    </div>
  )
}
