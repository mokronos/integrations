import { ChevronRight } from "lucide-react"
import { Option, type Schema } from "effect"
import { useState } from "react"

import { JsonView } from "@/components/json-view"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import {
  childrenOf,
  decodeJsonSchema,
  fieldCount,
  isExpandable,
  type JsonSchemaNode,
  resolve,
  typeLabel,
  valueLabel
} from "@/lib/json-schema"
import { cn } from "@/lib/utils"
import { pluralise } from "@/lib/format"

/** What a tool takes and what it gives back, read as fields rather than as a
 *  document.
 *
 * The schemas are the part of a tool an operator actually has to understand
 * before allowing it — "what can this call touch" is a question about its
 * arguments — and a pretty-printed JSON blob makes that a reading exercise.
 * Here each field is a row: name, type, whether it is required, what it
 * defaults to, what it is for. Nested shapes open on demand, so a schema with
 * sixty fields costs one screen until someone asks for more.
 *
 * The raw document stays one click away. This view is a reading of the schema;
 * when the two could differ, the document is what the tool actually enforces. */

/** Deep enough for any schema worth reading inline, and a stop for a `$ref`
 *  that points back at its own ancestor. */
const maxDepth = 8

function SchemaRow({
  name,
  schema,
  root,
  required,
  depth,
  showRequired = true
}: {
  readonly name: string
  readonly schema: JsonSchemaNode
  readonly root: JsonSchemaNode
  readonly required: boolean
  readonly depth: number
  readonly showRequired?: boolean
}) {
  const [open, setOpen] = useState(false)
  const expandable = depth < maxDepth && isExpandable(schema, root)
  // A `$ref`'d field carries its description on the definition it points at.
  const description = schema.description ?? resolve(schema, root).description

  const body = (
    <>
      <ItemMedia className="mt-0.5 size-4 self-start">
        {expandable
          ? (
            <ChevronRight
              aria-hidden
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
            />
          )
          : <span aria-hidden className="bg-muted-foreground/40 size-1 rounded-full" />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex-wrap gap-x-2 gap-y-0.5">
          <span className="truncate font-mono">{name}</span>
          <span className="text-muted-foreground font-mono text-xs font-normal">
            {typeLabel(schema, root)}
          </span>
          {showRequired
            ? (
              <span
                className={cn(
                  "text-xs font-normal",
                  required ? "text-foreground/70" : "text-muted-foreground"
                )}
              >
                {required ? "required" : "optional"}
              </span>
            )
            : null}
          {schema.default === undefined
            ? null
            : (
              <span className="text-muted-foreground font-mono text-xs font-normal">
                = {valueLabel(schema.default)}
              </span>
            )}
        </ItemTitle>
        {description === undefined
          ? null
          : <ItemDescription className="whitespace-pre-wrap">{description}</ItemDescription>}
      </ItemContent>
    </>
  )

  return (
    <li className="min-w-0">
      {expandable
        ? (
          <Item asChild interactive variant="plain" size="sm">
            <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
              {body}
            </button>
          </Item>
        )
        : <Item variant="plain" size="sm" className="items-start">{body}</Item>}

      {open && expandable
        ? (
          <div className="border-border/60 ml-4 border-l pl-1">
            <SchemaChildren schema={schema} root={root} depth={depth + 1} />
          </div>
        )
        : null}
    </li>
  )
}

function SchemaChildren({
  schema,
  root,
  depth
}: {
  readonly schema: JsonSchemaNode
  readonly root: JsonSchemaNode
  readonly depth: number
}) {
  const children = childrenOf(schema, root)

  switch (children.kind) {
    case "properties":
      return (
        <ul className="min-w-0">
          {children.properties.map((property) => (
            <SchemaRow
              key={property.name}
              name={property.name}
              schema={property.schema}
              root={root}
              required={property.required}
              depth={depth}
            />
          ))}
        </ul>
      )

    case "items":
      return (
        <ul className="min-w-0">
          <SchemaRow
            name="items"
            schema={children.schema}
            root={root}
            required
            depth={depth}
            showRequired={false}
          />
        </ul>
      )

    case "values":
      return (
        <ul className="min-w-0">
          <SchemaRow
            name="[key]"
            schema={children.schema}
            root={root}
            required
            depth={depth}
            showRequired={false}
          />
        </ul>
      )

    case "variants":
      return (
        <div className="min-w-0">
          <p className="text-muted-foreground px-2.5 py-1 text-xs tracking-wide uppercase">
            {children.keyword === "oneOf" ? "One of" : "Any of"}
          </p>
          <ul className="min-w-0">
            {children.variants.map((variant, index) => (
              <SchemaRow
                key={variant.title ?? `${index}`}
                name={variant.title ?? `option ${index + 1}`}
                schema={variant}
                root={root}
                required={false}
                depth={depth}
                showRequired={false}
              />
            ))}
          </ul>
        </div>
      )

    case "none":
      return null
  }
}

export function SchemaView({
  schema,
  definitions,
  label
}: {
  readonly schema: Schema.Json | undefined
  readonly definitions?: { readonly [key: string]: Schema.Json } | undefined
  readonly label: string
}) {
  const decoded = decodeJsonSchema(schema, definitions)

  if (schema === undefined || schema === null) {
    return (
      <div className="min-w-0 self-start rounded-lg border">
        <p className="text-muted-foreground border-b px-3 py-2 text-xs tracking-wide uppercase">
          {label}
        </p>
        <p className="text-muted-foreground px-3 py-2.5 text-sm">Not declared.</p>
      </div>
    )
  }

  // A schema this view cannot model is shown as what it is. Guessing at a
  // structured reading of an unrecognised document is the one outcome worse
  // than the raw JSON, because it looks authoritative.
  if (Option.isNone(decoded)) {
    return (
      <div className="min-w-0 self-start rounded-lg border">
        <p className="text-muted-foreground border-b px-3 py-2 text-xs tracking-wide uppercase">
          {label}
        </p>
        <div className="p-2">
          <JsonView value={schema} label="raw document" />
        </div>
      </div>
    )
  }

  const root = decoded.value
  const fields = fieldCount(root)

  return (
    <div className="min-w-0 self-start rounded-lg border">
      <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
        <p className="text-muted-foreground text-xs tracking-wide uppercase">{label}</p>
        <p className="text-muted-foreground ml-auto text-xs tabular-nums">
          {fields === 0 ? typeLabel(root, root) : pluralise(fields, "field")}
        </p>
      </div>
      {fields === 0
        ? (
          <p className="text-muted-foreground px-3 py-2.5 text-sm">
            {root.description ?? "No fields."}
          </p>
        )
        : <div className="p-1"><SchemaChildren schema={root} root={root} depth={0} /></div>}
      <div className="border-t p-2">
        <JsonView value={schema} label="raw document" />
      </div>
    </div>
  )
}
