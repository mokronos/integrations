import { Option } from "effect"

export const whenPresent = <K extends string, V>(
  key: K,
  value: V | null | undefined
): { readonly [P in K]?: V } =>
  Option.match(Option.fromNullishOr(value), {
    onNone: () => ({}),
    onSome: (present) => {
      const field: { [P in K]?: V } = {}
      field[key] = present
      return field
    }
  })

export const whenPresentMap = <K extends string, V, W>(
  key: K,
  value: V | null | undefined,
  map: (present: V) => W
): { readonly [P in K]?: W } =>
  Option.match(Option.map(Option.fromNullishOr(value), map), {
    onNone: () => ({}),
    onSome: (present) => {
      const field: { [P in K]?: W } = {}
      field[key] = present
      return field
    }
  })

export const whenPresentFields = <V, T extends object>(
  value: V | null | undefined,
  fields: (present: V) => T
) =>
  Option.match(Option.fromNullishOr(value), {
    onNone: () => ({}),
    onSome: fields
  })

export const whenTrue = <T extends object>(condition: boolean, fields: () => T) =>
  Option.match(condition ? Option.some(undefined) : Option.none(), {
    onNone: () => ({}),
    onSome: fields
  })
