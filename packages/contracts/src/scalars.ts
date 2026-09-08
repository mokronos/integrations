import { Schema, SchemaTransformation } from "effect"

export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("PositiveInt")
)
export type PositiveInt = typeof PositiveInt.Type

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("NonNegativeInt")
)
export type NonNegativeInt = typeof NonNegativeInt.Type

const IntegerString = Schema.String.annotate({ expected: "an integer" })
  .check(Schema.isPattern(/^[+-]?\d+$/))
  .pipe(Schema.decodeTo(Schema.FiniteFromString))

export const PositiveIntFromString = IntegerString.pipe(Schema.decodeTo(PositiveInt))
export const NonNegativeIntFromString = IntegerString.pipe(Schema.decodeTo(NonNegativeInt))

export const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (value) => value === "true",
      encode: (value) => (value ? "true" as const : "false" as const)
    })
  )
)
