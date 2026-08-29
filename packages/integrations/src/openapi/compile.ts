import Oas from "oas"
import type { Operation } from "oas/operation"
import OASNormalize from "oas-normalize"
import { Effect, Option, Schema } from "effect"
import { describeCause, SpecError } from "../errors.ts"
import { whenPresent } from "@mokronos/contracts"
import { OpenApiPreview } from "@mokronos/contracts"
import {
  asJson,
  isJsonBoolean,
  isJsonObject,
  isJsonString,
  objectEntries,
  property,
  stringEntries,
  type Json
} from "@mokronos/contracts"

/** Turning an OpenAPI document into callable tools.
 *
 *  `oas-normalize` parses, upconverts Swagger 2.0, and dereferences; `oas`
 *  projects each operation's parameters and responses into JSON Schema. What
 *  this module owns is the part no library has an opinion about: flattening an
 *  operation's four parameter locations into the single input object a tool
 *  caller sees, and splitting a caller's flat input back apart when the request
 *  is built. */


export const HttpMethod = Schema.Literals([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace"
])
export type HttpMethod = typeof HttpMethod.Type

/** Where a flattened input property came from, so the request builder can put
 *  it back. `body` means the property belongs inside the request body. */
export const ParameterLocation = Schema.Literals([
  "path",
  "query",
  "header",
  "cookie",
  "body"
])
export type ParameterLocation = typeof ParameterLocation.Type

/** One declared parameter, with the serialisation OpenAPI specifies for it.
 *
 *  `style` and `explode` both have location-dependent defaults, so they are
 *  resolved here rather than left for the request builder to re-derive. */
export interface CompiledParameter {
  readonly name: string
  readonly location: ParameterLocation
  readonly style: string
  readonly explode: boolean
  readonly required: boolean
}

export interface CompiledOperation {
  /** The tool name this operation is exposed under. */
  readonly name: string
  readonly method: HttpMethod
  readonly path: string
  readonly summary: Option.Option<string>
  readonly description: Option.Option<string>
  readonly tags: ReadonlyArray<string>
  readonly deprecated: boolean
  /** A safe method is the only thing this host will call read-only. It is a
   *  property of HTTP, not of a vendor annotation, so it can be trusted. */
  readonly readOnly: boolean
  readonly inputSchema: Json
  readonly outputSchema: Option.Option<Json>
  readonly schemaDefinitions: Record<string, Json>
  /** Property name to the location it must be sent in. */
  readonly locations: Record<string, ParameterLocation>
  /** Set when the operation has a request body; names the input property that
   *  carries it. */
  readonly bodyProperty: Option.Option<string>
  /** Every declared parameter, for the request builder. */
  readonly parameters: ReadonlyArray<CompiledParameter>
  /** The media type the request body is sent as. */
  readonly contentType: Option.Option<string>
}

export interface CompiledSecurityScheme {
  readonly name: string
  readonly type: "http" | "apiKey" | "oauth2" | "openIdConnect"
  readonly scheme: Option.Option<string>
  readonly bearerFormat: Option.Option<string>
  readonly in: Option.Option<"header" | "query" | "cookie">
  readonly headerName: Option.Option<string>
  readonly description: Option.Option<string>
  readonly openIdConnectUrl: Option.Option<string>
  /** Every scope the document mentions for this scheme, across all flows. */
  readonly scopes: ReadonlyArray<string>
  readonly authorizationUrl: Option.Option<string>
  readonly tokenUrl: Option.Option<string>
}

export interface CompiledSpec {
  readonly title: Option.Option<string>
  readonly description: Option.Option<string>
  readonly version: Option.Option<string>
  readonly servers: ReadonlyArray<{
    readonly url: string
    readonly description: Option.Option<string>
    /** Default values for the `{variable}` placeholders in `url`. */
    readonly variables: Readonly<Record<string, string>>
  }>
  readonly securitySchemes: ReadonlyArray<CompiledSecurityScheme>
  readonly operations: ReadonlyArray<CompiledOperation>
  /** The dereferenced document, handed to the request builder unchanged. */
  readonly document: Json
}

/** `oas` emits draft-04 with OpenAPI's own dialect quirks. Normalising here
 *  keeps every schema this host publishes in one shape, so a caller does not
 *  have to know which document a tool came from. */
const normalizeSchema = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(normalizeSchema)
  if (!isJsonObject(value)) return value

  const result: Record<string, Json> = {}
  for (const [key, entry] of Object.entries(value)) {
    // Drafts and examples are noise to a caller deciding how to call a tool.
    if (key === "$schema" || key === "example" || key === "examples") continue
    if (key === "nullable") continue
    if ((key === "exclusiveMinimum" || key === "exclusiveMaximum") && isJsonBoolean(entry)) {
      // Draft-04 spells these as flags on `minimum`/`maximum`; modern drafts
      // spell them as the bound itself. Dropping the flag is lossy in one
      // direction only, and it is the direction that keeps the schema valid.
      continue
    }
    result[key] = normalizeSchema(entry)
  }

  // `nullable: true` is OpenAPI's way of widening a type; every modern
  // consumer expects the union instead.
  const type = result["type"] ?? null
  if (property(value, "nullable") === true && isJsonString(type)) {
    result["type"] = [type, "null"]
  }
  return result
}

const propertiesOf = (schema: Json): Record<string, Json> =>
  objectEntries(property(schema, "properties"))

const requiredOf = (schema: Json): ReadonlyArray<string> =>
  stringEntries(property(schema, "required"))

/** The definitions bag `oas` attaches to a body schema, lifted out so it can be
 *  published as the tool's `schemaDefinitions`. */
const definitionsOf = (schema: Json): Record<string, Json> =>
  objectEntries(property(property(schema, "components"), "schemas"))

const withoutDefinitions = (schema: Json): Json => {
  if (!isJsonObject(schema)) return schema
  const { components: _components, ...rest } = schema
  return rest
}

const componentPointer = "#/components/schemas/"
const definitionPointer = "#/$defs/"

/** Bundled documents point at `#/components/schemas/X`, which means nothing
 *  once a single operation's schema is lifted out of the document. Re-pointing
 *  at `#/$defs/X` lets the schema carry its own definitions and be validated
 *  standalone. */
const rewriteDefinitionRefs = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(rewriteDefinitionRefs)
  if (!isJsonObject(value)) return value
  const result: Record<string, Json> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && isJsonString(entry) && entry.startsWith(componentPointer)) {
      result[key] = `${definitionPointer}${entry.slice(componentPointer.length)}`
      continue
    }
    result[key] = rewriteDefinitionRefs(entry)
  }
  return result
}

const referencedNames = (value: Json, into: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const entry of value) referencedNames(entry, into)
    return
  }
  if (!isJsonObject(value)) return
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && isJsonString(entry) && entry.startsWith(definitionPointer)) {
      into.add(entry.slice(definitionPointer.length))
      continue
    }
    referencedNames(entry, into)
  }
}

/** Only the definitions a schema actually reaches, followed transitively. A
 *  Gmail tool references three of the document's fifty-six schemas; publishing
 *  all of them would bury the one a caller needs to read. */
const reachableDefinitions = (
  roots: ReadonlyArray<Json>,
  available: Record<string, Json>
) => {
  const names = new Set<string>()
  for (const root of roots) referencedNames(root, names)
  const resolved: Record<string, Json> = {}
  const pending = [...names]
  while (pending.length > 0) {
    const name = pending.pop()
    if (name === undefined || name in resolved) continue
    const definition = available[name]
    if (definition === undefined) continue
    resolved[name] = definition
    const nested = new Set<string>()
    referencedNames(definition, nested)
    for (const next of nested) if (!(next in resolved)) pending.push(next)
  }
  return resolved
}

/** Attaches a schema's own definitions so it validates on its own. */
const selfContained = (schema: Json, definitions: Record<string, Json>): Json => {
  if (!isJsonObject(schema)) return schema
  const reachable = reachableDefinitions([schema], definitions)
  return Object.keys(reachable).length === 0
    ? schema
    : { ...schema, $defs: reachable }
}

/** Merges an operation's parameter groups into the one object a tool caller
 *  fills in.
 *
 *  Path, query, header and cookie parameters take their own names. The request
 *  body always travels whole, under `body`.
 *
 *  Flattening the body's properties alongside the parameters would read more
 *  naturally — `{ userId, raw }` rather than `{ userId, body: { raw } }` — but
 *  only when it is possible, and it is not always: a body behind a `$ref`
 *  exposes no properties to merge, and one whose property collided with a
 *  parameter would have to nest anyway. That makes the shape depend on the
 *  document rather than on the rule, and a caller cannot learn a rule that has
 *  exceptions. One predictable place is worth more than one less level. */
const flattenParameters = (
  operation: Operation
) => {
  const groups = operation.getParametersAsJSONSchema() ?? []
  const properties: Record<string, Json> = {}
  const required: Array<string> = []
  const locations: Record<string, ParameterLocation> = {}
  const schemaDefinitions: Record<string, Json> = {}
  let bodyProperty = Option.none<string>()

  for (const group of groups) {
    const rawSchema = asJson(group.schema)
    for (const [name, definition] of Object.entries(definitionsOf(rawSchema))) {
      schemaDefinitions[name] = rewriteDefinitionRefs(normalizeSchema(definition))
    }
    const schema = rewriteDefinitionRefs(normalizeSchema(withoutDefinitions(rawSchema)))

    if (group.type === "body" || group.type === "formData") {
      // `requestBody` only when a parameter has already claimed `body`, which
      // is the one case where the usual name is not available.
      const name = "body" in properties ? "requestBody" : "body"
      properties[name] = schema
      locations[name] = "body"
      if (operation.hasRequiredRequestBody()) required.push(name)
      bodyProperty = Option.some(name)
      continue
    }

    const location = Option.getOrElse(
      Schema.decodeUnknownOption(ParameterLocation)(group.type),
      (): ParameterLocation => "query"
    )
    for (const [name, value] of Object.entries(propertiesOf(schema))) {
      properties[name] = value
      locations[name] = location
    }
    required.push(...requiredOf(schema))
  }

  const flatSchema: Json = {
    type: "object",
    properties,
    ...whenPresent("required", required.length === 0 ? undefined : [...new Set(required)]),
    additionalProperties: false
  }
  return {
    inputSchema: selfContained(flatSchema, schemaDefinitions),
    locations,
    schemaDefinitions,
    bodyProperty
  }
}

/** The success response's schema, when the document declares a readable one.
 *  Preferring the lowest 2xx matches what a caller gets on the happy path. */
const successSchema = (operation: Operation): Option.Option<Json> => {
  const codes = operation.getResponseStatusCodes()
  const success = codes
    .filter((code) => /^2\d\d$/.test(code))
    .toSorted((left, right) => Number(left) - Number(right))[0]
  if (success === undefined) return Option.none()
  const projected = Option.liftThrowable(() =>
    operation.getResponseAsJSONSchema(success)
  )()
  return Option.flatMap(projected, (schemas) => {
    const first = Array.isArray(schemas) ? schemas[0] : undefined
    if (first === undefined) return Option.none()
    const raw = asJson(first.schema)
    if (raw === null) return Option.none()
    const definitions = Object.fromEntries(
      Object.entries(definitionsOf(raw)).map(([name, definition]) => [
        name,
        rewriteDefinitionRefs(normalizeSchema(definition))
      ])
    )
    const projected = rewriteDefinitionRefs(normalizeSchema(withoutDefinitions(raw)))
    return Option.some(selfContained(projected, definitions))
  })
}

const safeMethods = new Set(["get", "head", "options", "trace"])

/** A tool name for an operation that declares no `operationId`. Derived from
 *  method and path so it is stable across refreshes of the same document. */
const derivedName = (method: string, path: string): string => {
  const segments = path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/^\{(.+)\}$/, "by_$1").replace(/[^A-Za-z0-9]+/g, "_"))
  return [method, ...segments].join("_")
}

/** OpenAPI's defaults: `form`/exploded in a query and a cookie, `simple`/not
 *  exploded in a path and a header. */
const defaultStyle = (location: ParameterLocation): string =>
  location === "query" || location === "cookie" ? "form" : "simple"

const defaultExplode = (style: string): boolean => style === "form"

const compileParameters = (operation: Operation): ReadonlyArray<CompiledParameter> =>
  operation.getParameters().flatMap((parameter) => {
    const location = Option.getOrUndefined(
      Schema.decodeUnknownOption(ParameterLocation)(parameter.in)
    )
    if (location === undefined) return []
    const style = parameter.style ?? defaultStyle(location)
    return [{
      name: parameter.name,
      location,
      style,
      explode: parameter.explode ?? defaultExplode(style),
      required: parameter.required === true
    }]
  })

const compileOperation = (
  method: HttpMethod,
  path: string,
  operation: Operation
): CompiledOperation => {
  const flattened = flattenParameters(operation)
  const operationId = operation.hasOperationId()
    ? operation.getOperationId()
    : derivedName(method, path)
  return {
    name: operationId,
    method,
    path,
    summary: Option.fromNullishOr(operation.getSummary()),
    description: Option.fromNullishOr(operation.getDescription()),
    tags: operation.getTags().map((tag) => tag.name),
    deprecated: operation.isDeprecated(),
    readOnly: safeMethods.has(method),
    inputSchema: flattened.inputSchema,
    outputSchema: successSchema(operation),
    schemaDefinitions: flattened.schemaDefinitions,
    locations: flattened.locations,
    bodyProperty: flattened.bodyProperty,
    parameters: compileParameters(operation),
    contentType: operation.hasRequestBody()
      ? Option.fromNullishOr(operation.getContentType())
      : Option.none()
  }
}

const DeclaredSecurityScheme = Schema.Struct({
  type: Schema.Literals(["http", "apiKey", "oauth2", "openIdConnect"]),
  scheme: Schema.optional(Schema.String),
  bearerFormat: Schema.optional(Schema.String),
  in: Schema.optional(Schema.Literals(["header", "query", "cookie"])),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  openIdConnectUrl: Schema.optional(Schema.String),
  flows: Schema.optional(Schema.Record(
    Schema.String,
    Schema.Struct({
      authorizationUrl: Schema.optional(Schema.String),
      tokenUrl: Schema.optional(Schema.String),
      scopes: Schema.optional(Schema.Record(Schema.String, Schema.String))
    })
  ))
})

const compileSecuritySchemes = (document: Json): ReadonlyArray<CompiledSecurityScheme> => {
  const fromComponents = property(property(document, "components"), "securitySchemes")
  // Swagger 2.0 upconverts to `components`, but a hand-written 2.0 document
  // that skipped conversion would still carry `securityDefinitions`.
  const raw = isJsonObject(fromComponents)
    ? fromComponents
    : property(document, "securityDefinitions")
  if (!isJsonObject(raw)) return []

  return Object.entries(raw).flatMap(([name, value]) =>
    Option.match(Schema.decodeUnknownOption(DeclaredSecurityScheme)(value), {
      onNone: () => [],
      onSome: (scheme) => {
        const flows = Object.values(scheme.flows ?? {})
        const scopes = [
          ...new Set(flows.flatMap((flow) => Object.keys(flow.scopes ?? {})))
        ]
        return [{
          name,
          type: scheme.type,
          scheme: Option.fromNullishOr(scheme.scheme),
          bearerFormat: Option.fromNullishOr(scheme.bearerFormat),
          in: Option.fromNullishOr(scheme.in),
          headerName: Option.fromNullishOr(scheme.name),
          description: Option.fromNullishOr(scheme.description),
          openIdConnectUrl: Option.fromNullishOr(scheme.openIdConnectUrl),
          scopes,
          authorizationUrl: Option.fromNullishOr(
            flows.map((flow) => flow.authorizationUrl).find((url) => url !== undefined)
          ),
          tokenUrl: Option.fromNullishOr(
            flows.map((flow) => flow.tokenUrl).find((url) => url !== undefined)
          )
        }]
      }
    })
  )
}

/** Parses, upconverts and dereferences a document, then projects every
 *  operation. Pure with respect to the network: the caller has already fetched
 *  the text, so this can run against a cached copy. */
export const compileSpec = (
  source: string,
  text: string
): Effect.Effect<CompiledSpec, SpecError> =>
  Effect.tryPromise({
    try: async () => {
      const normalized = new OASNormalize(text)
      const version = await normalized.version()
      // A Swagger 2.0 document has to become OpenAPI 3 before `oas` will look
      // at it; bundling alone leaves the version untouched.
      //
      // `bundle` and not `deref`: a document with a recursive schema — Gmail's
      // `Message` contains `MessagePart` which contains itself — dereferences
      // into a cyclic object graph, and `oas` clones schemas through
      // `JSON.stringify`, so it throws outright on one. Bundling keeps internal
      // `$ref`s, which both `oas` and the request builder resolve themselves.
      const document = version.specification === "openapi"
        ? await normalized.bundle()
        : await new OASNormalize(await normalized.convert()).bundle()
      return document
    },
    catch: (cause) => new SpecError({
      source,
      detail: describeCause(cause),
      cause
    })
  }).pipe(
    Effect.flatMap((document) => Effect.try({
      try: (): CompiledSpec => {
        const documentJson = asJson(document)
        // `Oas.init` is the library's documented entry point for a document it
        // has not itself typed — which is exactly what `deref` hands back, since
        // its return type is the Swagger-2-or-OpenAPI-3 union either way.
        const oas = Oas.init(isJsonObject(documentJson) ? { ...documentJson } : {})
        const definition = oas.getDefinition()
        const operations: Array<CompiledOperation> = []

        for (const [path, methods] of Object.entries(oas.getPaths())) {
          for (const [rawMethod, operation] of Object.entries(methods)) {
            const method = Option.getOrUndefined(
              Schema.decodeUnknownOption(HttpMethod)(rawMethod)
            )
            if (method === undefined) continue
            operations.push(compileOperation(method, path, operation))
          }
        }

        return {
          title: Option.fromNullishOr(definition.info?.title),
          description: Option.fromNullishOr(definition.info?.description),
          version: Option.fromNullishOr(definition.info?.version),
          servers: (definition.servers ?? []).map((server) => ({
            url: server.url,
            description: Option.fromNullishOr(server.description),
            variables: Object.fromEntries(
              Object.entries(server.variables ?? {}).flatMap(([name, variable]) =>
                variable.default === undefined ? [] : [[name, String(variable.default)]]
              )
            )
          })),
          securitySchemes: compileSecuritySchemes(documentJson),
          operations: operations.toSorted((left, right) => left.name.localeCompare(right.name)),
          document: documentJson
        }
      },
      catch: (cause) => new SpecError({
        source,
        detail: `Could not project operations: ${describeCause(cause)}`,
        cause
      })
    }))
  )

/** The read-only summary the dashboard and CLI show before anything is
 *  installed. */
export const previewOf = (
  compiled: CompiledSpec
): Effect.Effect<OpenApiPreview, SpecError> =>
  Schema.decodeUnknownEffect(OpenApiPreview)({
    title: Option.getOrNull(compiled.title),
    description: Option.getOrNull(compiled.description),
    version: Option.getOrNull(compiled.version),
    operationCount: compiled.operations.length,
    operations: compiled.operations.map((operation) => ({
      operationId: operation.name,
      method: operation.method,
      path: operation.path,
      summary: Option.getOrNull(operation.summary),
      tags: operation.tags,
      deprecated: operation.deprecated
    })),
    tags: [...new Set(compiled.operations.flatMap((operation) => operation.tags))],
    servers: compiled.servers.map((server) => ({
      url: server.url,
      description: Option.getOrNull(server.description)
    })),
    securitySchemes: compiled.securitySchemes.map((scheme) => ({
      name: scheme.name,
      type: scheme.type,
      scheme: Option.getOrNull(scheme.scheme),
      bearerFormat: Option.getOrNull(scheme.bearerFormat),
      in: Option.getOrNull(scheme.in),
      headerName: Option.getOrNull(scheme.headerName),
      description: Option.getOrNull(scheme.description),
      openIdConnectUrl: Option.getOrNull(scheme.openIdConnectUrl)
    }))
  }).pipe(Effect.mapError((cause) =>
    new SpecError({
      source: Option.getOrElse(compiled.title, () => "specification"),
      detail: "Could not describe the document",
      cause
    })
  ))


/** Where the request should go, given the document's servers and any override
 *  recorded when the integration was installed.
 *
 *  A document may declare a relative server — Swagger's own petstore says
 *  `/api/v3` — which is only resolvable against wherever the document itself
 *  was fetched from. */
export const resolveServer = (
  compiled: CompiledSpec,
  options: {
    readonly baseUrl: Option.Option<string>
    readonly specSource: Option.Option<string>
  }
): Option.Option<string> => {
  if (Option.isSome(options.baseUrl)) return options.baseUrl
  const server = compiled.servers[0]
  if (server === undefined) return options.specSource
  // A server may template its own host or version — `https://api/{ver}` — and
  // the declared defaults are the only values we have for them. Filled in here
  // because this result is stored, and nothing downstream keeps the document.
  const declared = server.url.replace(
    /\{([^{}]+)\}/g,
    (whole, name: string) => server.variables[name] ?? whole
  )
  if (/^https?:\/\//.test(declared)) return Option.some(declared)
  return Option.map(options.specSource, (source) => new URL(declared, source).toString())
}

