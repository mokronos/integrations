import {
  JsonSchema as EffectJsonSchema,
  Schema,
  SchemaRepresentation
} from "effect"
import type { JsonSchema } from "../schemas.ts"

const RuntimeJsonSchema = Schema.declare<EffectJsonSchema.JsonSchema>(
  (value): value is EffectJsonSchema.JsonSchema =>
    typeof value === "object" && value !== null && !Array.isArray(value)
)

/** Validate a value from a JSON Schema persisted in workflow history. */
export const decodePersistedJsonSchema = (
  schema: JsonSchema,
  value: unknown
): unknown => {
  const runtimeSchema = Schema.decodeUnknownSync(RuntimeJsonSchema)(schema)
  const document = EffectJsonSchema.fromSchemaDraft2020_12(runtimeSchema)
  return Schema.decodeUnknownSync(
    SchemaRepresentation.toSchema<Schema.Decoder<unknown, never>>(
      SchemaRepresentation.fromJsonSchemaDocument(document)
    )
  )(value)
}
