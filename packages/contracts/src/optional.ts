import { Option } from "effect"

/** Spread form for including an exact optional property only when present. */
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

/** As {@link whenPresent}, converting a present value before including it. */
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
