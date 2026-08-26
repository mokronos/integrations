/** Scalars that carry their constraint in the type, and the text forms they
 *  arrive in.
 *
 *  A count that must be positive and an offset that must not be negative are
 *  both `number`; a query flag is a `boolean` that reaches us as `"true"`.
 *  Naming them here means the check happens once, at the boundary that decodes
 *  them, and every reader downstream can see from the type that it already
 *  happened. */
import { Schema, SchemaTransformation } from "effect"

/** A whole number greater than zero — a page size, a budget, a rate. */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("PositiveInt")
)
export type PositiveInt = typeof PositiveInt.Type

/** A whole number that may be zero — an offset, a tally. */
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("NonNegativeInt")
)
export type NonNegativeInt = typeof NonNegativeInt.Type

/** Digits only, so the leniency of `Number` never becomes the contract:
 *  `0x10`, `1e3`, `" 5 "` and `""` are all numbers to JavaScript and none of
 *  them are what a caller writing `?limit=` meant. */
const IntegerString = Schema.String.annotate({ expected: "an integer" })
  .check(Schema.isPattern(/^[+-]?\d+$/))
  .pipe(Schema.decodeTo(Schema.FiniteFromString))

/** For query strings, headers and environment variables, which carry every
 *  number as text. Pair with `Schema.withDecodingDefaultTypeKey` at the use
 *  site when the field is optional — the fallback belongs to the endpoint that
 *  chose it, not to the type. */
export const PositiveIntFromString = IntegerString.pipe(Schema.decodeTo(PositiveInt))
export const NonNegativeIntFromString = IntegerString.pipe(Schema.decodeTo(NonNegativeInt))

/** A flag as a query string carries it. Declaring it on the endpoint is what
 *  stops a handler from re-deciding what counts as true. */
export const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (value) => value === "true",
      encode: (value) => (value ? "true" as const : "false" as const)
    })
  )
)
