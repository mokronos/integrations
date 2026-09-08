import { Effect, Option, Schema } from "effect"
import { SpecError } from "../errors.ts"
import { isJsonBoolean, isJsonObject, isJsonString, type Json } from "@mokronos/contracts"
import { whenPresent } from "@mokronos/contracts"


const DiscoverySchemaRef = Schema.Struct({
  $ref: Schema.optional(Schema.String)
})

const DiscoveryParameter = Schema.Struct({
  description: Schema.optional(Schema.String),
  location: Schema.optional(Schema.Literals(["path", "query"])),
  required: Schema.optional(Schema.Boolean),
  repeated: Schema.optional(Schema.Boolean),
  type: Schema.optional(Schema.String),
  format: Schema.optional(Schema.String),
  enum: Schema.optional(Schema.Array(Schema.String)),
  enumDescriptions: Schema.optional(Schema.Array(Schema.String)),
  default: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String)
})
type DiscoveryParameter = typeof DiscoveryParameter.Type

const DiscoveryMethod = Schema.Struct({
  id: Schema.optional(Schema.String),
  path: Schema.String,
  httpMethod: Schema.String,
  description: Schema.optional(Schema.String),
  deprecated: Schema.optional(Schema.Boolean),
  parameters: Schema.optional(Schema.Record(Schema.String, DiscoveryParameter)),
  parameterOrder: Schema.optional(Schema.Array(Schema.String)),
  request: Schema.optional(DiscoverySchemaRef),
  response: Schema.optional(DiscoverySchemaRef),
  scopes: Schema.optional(Schema.Array(Schema.String)),
  supportsMediaUpload: Schema.optional(Schema.Boolean),
  mediaUpload: Schema.optional(Schema.Struct({
    accept: Schema.optional(Schema.Array(Schema.String))
  }))
})
type DiscoveryMethod = typeof DiscoveryMethod.Type

const DiscoveryResource = Schema.Struct({
  methods: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  resources: Schema.optional(Schema.Record(Schema.String, Schema.Json))
})

const DiscoveryDocument = Schema.Struct({
  kind: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  documentationLink: Schema.optional(Schema.String),
  rootUrl: Schema.optional(Schema.String),
  servicePath: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  parameters: Schema.optional(Schema.Record(Schema.String, DiscoveryParameter)),
  schemas: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  resources: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  auth: Schema.optional(Schema.Struct({
    oauth2: Schema.optional(Schema.Struct({
      scopes: Schema.optional(Schema.Record(
        Schema.String,
        Schema.Struct({ description: Schema.optional(Schema.String) })
      ))
    }))
  }))
})
type DiscoveryDocument = typeof DiscoveryDocument.Type

export const isGoogleDiscoveryUrl = (url: string): boolean =>
  /^https?:\/\/[^/]*googleapis\.com\/discovery\/v1\/apis\//.test(url) ||
  /^https?:\/\/[^/]*\.googleapis\.com\/\$discovery\/rest/.test(url) ||
  /\/discovery\/v1\/apis\/[^/]+\/[^/]+\/rest$/.test(url)

const rewriteRefs = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(rewriteRefs)
  if (!isJsonObject(value)) return value
  const result: Record<string, Json> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && isJsonString(entry)) {
      result["$ref"] = entry.startsWith("#/")
        ? entry
        : `#/components/schemas/${entry}`
      continue
    }
    if (key === "required" && isJsonBoolean(entry)) continue
    if (key === "annotations" || key === "id") continue
    result[key] = rewriteRefs(entry)
  }
  return result
}

const parameterSchema = (parameter: DiscoveryParameter): Json => {
  const base = {
    type: parameter.type === "any" ? "string" : parameter.type ?? "string",
    ...whenPresent("format", parameter.format),
    ...whenPresent("description", parameter.description),
    ...whenPresent("pattern", parameter.pattern),
    ...whenPresent("default", parameter.default),
    ...whenPresent("enum", parameter.enum === undefined ? undefined : [...parameter.enum])
  }
  return parameter.repeated === true
    ? { type: "array", items: base, ...whenPresent("description", parameter.description) }
    : base
}

const openApiParameters = (
  parameters: Readonly<Record<string, DiscoveryParameter>>,
  pathTemplate: string
): ReadonlyArray<Json> =>
  Object.entries(parameters).flatMap(([name, parameter]) => {
    const inPath = parameter.location === "path"
    if (inPath && !pathTemplate.includes(`{${name}}`)) return []
    return [{
      name,
      in: inPath ? "path" : "query",
      required: inPath ? true : parameter.required === true,
      ...whenPresent("description", parameter.description),
      schema: parameterSchema(parameter)
    }]
  })

const requestBody = (method: DiscoveryMethod): Option.Option<Json> => {
  const reference = method.request?.$ref
  if (reference === undefined) return Option.none()
  const schema: Json = { $ref: `#/components/schemas/${reference}` }
  return Option.some({
    required: false,
    content: { "application/json": { schema } }
  })
}

const responses = (method: DiscoveryMethod): Json => {
  const reference = method.response?.$ref
  if (reference === undefined) {
    return { "204": { description: "Successful response with no content" } }
  }
  return {
    "200": {
      description: "Successful response",
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${reference}` }
        }
      }
    }
  }
}

const collectMethods = (
  resources: Readonly<Record<string, Json>>
): ReadonlyArray<DiscoveryMethod> => {
  const collected: Array<DiscoveryMethod> = []
  const walk = (entries: Readonly<Record<string, Json>>): void => {
    for (const value of Object.values(entries)) {
      const resource = Option.getOrUndefined(
        Schema.decodeUnknownOption(DiscoveryResource)(value)
      )
      if (resource === undefined) continue
      for (const rawMethod of Object.values(resource.methods ?? {})) {
        const method = Option.getOrUndefined(
          Schema.decodeUnknownOption(DiscoveryMethod)(rawMethod)
        )
        if (method !== undefined) collected.push(method)
      }
      if (resource.resources !== undefined) walk(resource.resources)
    }
  }
  walk(resources)
  return collected
}

const googleAuthorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth"
const googleTokenUrl = "https://oauth2.googleapis.com/token"

const convertDocument = (document: DiscoveryDocument): Json => {
  const globalParameters = document.parameters ?? {}
  const methods = collectMethods(document.resources ?? {})
  const paths: Record<string, Record<string, Json>> = {}

  for (const method of methods) {
    const path = `/${method.path.replace(/^\//, "")}`
    const verb = method.httpMethod.toLowerCase()
    const parameters = openApiParameters(
      { ...globalParameters, ...method.parameters },
      path
    )
    const body = requestBody(method)
    const operation = {
      operationId: method.id ?? `${verb}${path.replace(/[^A-Za-z0-9]+/g, "_")}`,
      ...whenPresent("description", method.description),
      ...whenPresent("summary", method.description?.split(".")[0]),
      parameters: [...parameters],
      responses: responses(method),
      ...whenPresent("deprecated", method.deprecated === true ? true : undefined),
      ...whenPresent(
        "security",
        method.scopes === undefined ? undefined : [{ oauth2: [...method.scopes] }]
      ),
      ...whenPresent("requestBody", Option.getOrUndefined(body))
    }
    const existing = paths[path] ?? {}
    paths[path] = { ...existing, [verb]: operation }
  }

  const schemas = Object.fromEntries(
    Object.entries(document.schemas ?? {}).map(([name, schema]) => [
      name,
      rewriteRefs(schema)
    ])
  )

  const scopes = Object.fromEntries(
    Object.entries(document.auth?.oauth2?.scopes ?? {}).map(([scope, detail]) => [
      scope,
      detail.description ?? scope
    ])
  )

  const root = document.rootUrl?.replace(/\/+$/, "")
  const servicePath = (document.servicePath ?? "").replace(/^\/+|\/+$/g, "")
  const serverUrl = root === undefined
    ? document.baseUrl
    : servicePath.length === 0 ? root : `${root}/${servicePath}`

  return {
    openapi: "3.0.3",
    info: {
      title: document.title ?? document.name ?? "Google API",
      version: document.version ?? "v1",
      ...whenPresent("description", document.description)
    },
    ...whenPresent(
      "servers",
      serverUrl === undefined ? undefined : [{ url: serverUrl }]
    ),
    paths,
    components: {
      schemas,
      ...whenPresent(
        "securitySchemes",
        Object.keys(scopes).length === 0 ? undefined : {
          oauth2: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: googleAuthorizationUrl,
                tokenUrl: googleTokenUrl,
                scopes
              }
            }
          }
        }
      )
    },
    ...whenPresent(
      "externalDocs",
      document.documentationLink === undefined
        ? undefined
        : { url: document.documentationLink }
    )
  }
}

export const convertGoogleDiscovery = (
  source: string,
  text: string
): Effect.Effect<string, SpecError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(DiscoveryDocument))(text).pipe(
    Effect.mapError((cause) =>
      new SpecError({
        source,
        detail: "Not a readable Google Discovery document",
        cause
      })
    ),
    Effect.map((document) => JSON.stringify(convertDocument(document)))
  )
