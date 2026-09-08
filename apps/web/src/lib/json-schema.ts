import { Option, Predicate, Schema } from "effect"

export interface JsonSchemaNode {
  readonly type?: string | ReadonlyArray<string> | undefined
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly format?: string | undefined
  readonly properties?: { readonly [key: string]: JsonSchemaNode } | undefined
  readonly required?: ReadonlyArray<string> | undefined
  readonly items?: JsonSchemaNode | ReadonlyArray<JsonSchemaNode> | undefined
  readonly additionalProperties?: boolean | JsonSchemaNode | undefined
  readonly oneOf?: ReadonlyArray<JsonSchemaNode> | undefined
  readonly anyOf?: ReadonlyArray<JsonSchemaNode> | undefined
  readonly allOf?: ReadonlyArray<JsonSchemaNode> | undefined
  readonly enum?: ReadonlyArray<Schema.Json> | undefined
  readonly const?: Schema.Json | undefined
  readonly default?: Schema.Json | undefined
  readonly $ref?: string | undefined
  readonly $defs?: { readonly [key: string]: JsonSchemaNode } | undefined
}

const node = Schema.suspend((): Schema.Codec<JsonSchemaNode> => JsonSchemaNode)

export const JsonSchemaNode: Schema.Codec<JsonSchemaNode> = Schema.Struct({
  type: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  format: Schema.optional(Schema.String),
  properties: Schema.optional(Schema.Record(Schema.String, node)),
  required: Schema.optional(Schema.Array(Schema.String)),
  items: Schema.optional(Schema.Union([node, Schema.Array(node)])),
  additionalProperties: Schema.optional(Schema.Union([Schema.Boolean, node])),
  oneOf: Schema.optional(Schema.Array(node)),
  anyOf: Schema.optional(Schema.Array(node)),
  allOf: Schema.optional(Schema.Array(node)),
  enum: Schema.optional(Schema.Array(Schema.Json)),
  const: Schema.optional(Schema.Json),
  default: Schema.optional(Schema.Json),
  $ref: Schema.optional(Schema.String),
  $defs: Schema.optional(Schema.Record(Schema.String, node))
})

const decodeNode = Schema.decodeUnknownOption(JsonSchemaNode)
const decodeDefinitions = Schema.decodeUnknownOption(Schema.Record(Schema.String, JsonSchemaNode))

export const decodeJsonSchema = (
  schema: Schema.Json | undefined,
  definitions?: { readonly [key: string]: Schema.Json }
): Option.Option<JsonSchemaNode> => {
  if (schema === undefined || schema === null) return Option.none()
  return decodeNode(schema).pipe(Option.map((decoded) =>
    definitions === undefined ? decoded : {
      ...decoded,
      $defs: {
        ...Option.getOrElse(decodeDefinitions(definitions), () => ({})),
        ...decoded.$defs
      }
    }
  ))
}

const isNode = (
  value: JsonSchemaNode | ReadonlyArray<JsonSchemaNode>
): value is JsonSchemaNode => !Array.isArray(value)

const itemsOf = (schema: JsonSchemaNode): JsonSchemaNode | undefined =>
  schema.items !== undefined && isNode(schema.items) ? schema.items : undefined

const definitionName = (ref: string): string | undefined =>
  /^#\/\$defs\/(.+)$/.exec(ref)?.[1]

const dereference = (ref: string, root: JsonSchemaNode): JsonSchemaNode | undefined => {
  const name = definitionName(ref)
  return name === undefined ? undefined : root.$defs?.[name]
}

export const resolve = (schema: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode => {
  const referenced = schema.$ref === undefined ? undefined : dereference(schema.$ref, root)
  const target = referenced ?? schema
  const single = target.oneOf?.length === 1
    ? target.oneOf[0]
    : target.anyOf?.length === 1 ? target.anyOf[0] : undefined
  return single === undefined ? target : resolve(single, root)
}

const composed = (parts: ReadonlyArray<JsonSchemaNode>, root: JsonSchemaNode): JsonSchemaNode =>
  parts.reduce<JsonSchemaNode>((accumulated, part) => {
    const resolved = resolve(part, root)
    return {
      type: "object",
      properties: { ...accumulated.properties, ...resolved.properties },
      required: [...accumulated.required ?? [], ...resolved.required ?? []]
    }
  }, { type: "object" })

export const valueLabel = (value: Schema.Json): string => {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

const typeNames = (schema: JsonSchemaNode): ReadonlyArray<string> =>
  schema.type === undefined
    ? []
    : Predicate.isString(schema.type) ? [schema.type] : schema.type

const unionLabel = (variants: ReadonlyArray<JsonSchemaNode>, root: JsonSchemaNode): string => {
  const labels = variants.slice(0, 3).map((variant) => typeLabel(variant, root))
  return [...labels, ...variants.length > 3 ? ["…"] : []].join(" | ")
}

export const typeLabel = (schema: JsonSchemaNode, root: JsonSchemaNode): string => {
  if (schema.$ref !== undefined) return definitionName(schema.$ref) ?? "$ref"
  if (schema.const !== undefined) return valueLabel(schema.const)
  if (schema.enum !== undefined) {
    return schema.enum.length <= 3
      ? schema.enum.map(valueLabel).join(" | ")
      : `enum (${schema.enum.length})`
  }
  if (schema.oneOf !== undefined) return unionLabel(schema.oneOf, root)
  if (schema.anyOf !== undefined) return unionLabel(schema.anyOf, root)
  if (schema.allOf !== undefined) {
    const named = schema.allOf.find((part) => part.$ref !== undefined)?.$ref
    return named === undefined ? "object" : definitionName(named) ?? "object"
  }

  const names = typeNames(schema)
  if (names.includes("array")) {
    const items = itemsOf(schema)
    return items === undefined ? "array" : `${typeLabel(items, root)}[]`
  }
  if (names.includes("object")) {
    const values = schema.additionalProperties
    return values === undefined || Predicate.isBoolean(values)
      ? "object"
      : `record<string, ${typeLabel(values, root)}>`
  }
  const only = names[0]
  if (names.length === 1 && only !== undefined) {
    return schema.format === undefined ? only : `${only} <${schema.format}>`
  }
  if (names.length > 1) return names.join(" | ")
  return "any"
}

export interface SchemaProperty {
  readonly name: string
  readonly schema: JsonSchemaNode
  readonly required: boolean
}

export type SchemaChildren =
  | { readonly kind: "properties"; readonly properties: ReadonlyArray<SchemaProperty> }
  | { readonly kind: "items"; readonly schema: JsonSchemaNode }
  | {
    readonly kind: "variants"
    readonly keyword: "oneOf" | "anyOf"
    readonly variants: ReadonlyArray<JsonSchemaNode>
  }
  | { readonly kind: "values"; readonly schema: JsonSchemaNode }
  | { readonly kind: "none" }

const hasProperties = (schema: JsonSchemaNode): boolean =>
  schema.properties !== undefined && Object.keys(schema.properties).length > 0

const propertiesOf = (schema: JsonSchemaNode): ReadonlyArray<SchemaProperty> => {
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {})
    .map(([name, property]) => ({ name, schema: property, required: required.has(name) }))
    .toSorted((left, right) =>
      left.required === right.required
        ? left.name.localeCompare(right.name)
        : left.required ? -1 : 1
    )
}

export const childrenOf = (schema: JsonSchemaNode, root: JsonSchemaNode): SchemaChildren => {
  const resolved = resolve(schema, root)

  if (hasProperties(resolved)) {
    return { kind: "properties", properties: propertiesOf(resolved) }
  }

  if (resolved.allOf !== undefined) {
    const merged = composed(resolved.allOf, root)
    if (hasProperties(merged)) return { kind: "properties", properties: propertiesOf(merged) }
  }

  const declaredItems = itemsOf(resolved)
  if (declaredItems !== undefined) {
    const items = resolve(declaredItems, root)
    return hasProperties(items)
      ? { kind: "properties", properties: propertiesOf(items) }
      : { kind: "items", schema: declaredItems }
  }

  const variants = resolved.oneOf ?? resolved.anyOf
  if (variants !== undefined && variants.length > 1) {
    return { kind: "variants", keyword: resolved.oneOf === undefined ? "anyOf" : "oneOf", variants }
  }

  const values = resolved.additionalProperties
  if (values !== undefined && !Predicate.isBoolean(values)) {
    return { kind: "values", schema: values }
  }

  return { kind: "none" }
}

export const isExpandable = (schema: JsonSchemaNode, root: JsonSchemaNode): boolean =>
  childrenOf(schema, root).kind !== "none"

export const fieldCount = (root: JsonSchemaNode): number => {
  const children = childrenOf(root, root)
  switch (children.kind) {
    case "properties":
      return children.properties.length
    case "variants":
      return children.variants.length
    case "items":
    case "values":
      return 1
    case "none":
      return 0
  }
}
