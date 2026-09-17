import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"

export type AssignableResource = { readonly id: string; readonly name: string; readonly isDefault: boolean }

export const defaultResourceId = (resources: ReadonlyArray<AssignableResource>) =>
  resources.find((resource) => resource.isDefault)?.id ?? ""

export function ResourceSelect({ label, value, onChange, resources }: {
  readonly label: string
  readonly value: string
  readonly onChange: (id: string) => void
  readonly resources: ReadonlyArray<AssignableResource>
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select
        className="w-full"
        value={value}
        onValueChange={(next) => { if (next !== null) onChange(next) }}
        items={resources.map((resource) => ({ value: resource.id, label: resource.isDefault ? `${resource.name} (default)` : resource.name }))}
      />
    </div>
  )
}
