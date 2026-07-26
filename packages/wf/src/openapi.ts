import { Schema } from "effect"
import { parse as parseYaml } from "yaml"

export const OpenApiHttpMethod = Schema.Literals(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"])
export type OpenApiHttpMethod = typeof OpenApiHttpMethod.Type

export const OpenApiParameterLocation = Schema.Literals(["path", "query", "header", "cookie", "reference"])
export type OpenApiParameterLocation = typeof OpenApiParameterLocation.Type

export const OpenApiParameter = Schema.Struct({
  name: Schema.String,
  location: OpenApiParameterLocation,
  required: Schema.Boolean,
  description: Schema.optional(Schema.String),
  schema: Schema.optional(Schema.Json),
  reference: Schema.optional(Schema.String)
})
export type OpenApiParameter = typeof OpenApiParameter.Type

export const OpenApiRequestBody = Schema.Struct({
  required: Schema.Boolean,
  contentTypes: Schema.Array(Schema.String),
  schema: Schema.optional(Schema.Json),
  reference: Schema.optional(Schema.String)
})
export type OpenApiRequestBody = typeof OpenApiRequestBody.Type

export const OpenApiResponse = Schema.Struct({
  status: Schema.String,
  description: Schema.optional(Schema.String),
  contentTypes: Schema.Array(Schema.String),
  schema: Schema.optional(Schema.Json),
  reference: Schema.optional(Schema.String)
})
export type OpenApiResponse = typeof OpenApiResponse.Type

export const OpenApiSecurityRequirement = Schema.Struct({
  schemes: Schema.Array(Schema.Struct({
    name: Schema.String,
    scopes: Schema.Array(Schema.String)
  }))
})
export type OpenApiSecurityRequirement = typeof OpenApiSecurityRequirement.Type

export const OpenApiSecurityScheme = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  scheme: Schema.optional(Schema.String),
  bearerFormat: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  parameterName: Schema.optional(Schema.String),
  openIdConnectUrl: Schema.optional(Schema.String),
  scopes: Schema.Array(Schema.String),
  reference: Schema.optional(Schema.String)
})
export type OpenApiSecurityScheme = typeof OpenApiSecurityScheme.Type

export const OpenApiOperation = Schema.Struct({
  operationId: Schema.String,
  method: OpenApiHttpMethod,
  path: Schema.String,
  server: Schema.String,
  summary: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  parameters: Schema.Array(OpenApiParameter),
  requestBody: Schema.optional(OpenApiRequestBody),
  responses: Schema.Array(OpenApiResponse),
  security: Schema.Array(OpenApiSecurityRequirement)
})
export type OpenApiOperation = typeof OpenApiOperation.Type

export const OpenApiDiscovery = Schema.Struct({
  specUrl: Schema.String,
  specHash: Schema.String,
  openapi: Schema.String,
  title: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  operations: Schema.Array(OpenApiOperation),
  securitySchemes: Schema.Array(OpenApiSecurityScheme)
})
export type OpenApiDiscovery = typeof OpenApiDiscovery.Type

const OpenApiReference = Schema.Struct({ $ref: Schema.String })
const OpenApiSchemaValue = Schema.Json

const OpenApiParameterObject = Schema.Struct({
  name: Schema.String,
  in: Schema.String,
  description: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
  schema: Schema.optional(OpenApiSchemaValue)
})
const OpenApiParameterValue = Schema.Union([OpenApiParameterObject, OpenApiReference])

const OpenApiMediaType = Schema.Struct({
  schema: Schema.optional(OpenApiSchemaValue)
})
const OpenApiContent = Schema.Record(Schema.String, OpenApiMediaType)

const OpenApiRequestBodyObject = Schema.Struct({
  required: Schema.optional(Schema.Boolean),
  content: Schema.optional(OpenApiContent)
})
const OpenApiRequestBodyValue = Schema.Union([OpenApiRequestBodyObject, OpenApiReference])

const OpenApiResponseObject = Schema.Struct({
  description: Schema.optional(Schema.String),
  content: Schema.optional(OpenApiContent)
})
const OpenApiResponseValue = Schema.Union([OpenApiResponseObject, OpenApiReference])

const OpenApiSecurityRequirementObject = Schema.Record(Schema.String, Schema.Array(Schema.String))
const OpenApiSecurityRequirements = Schema.Array(OpenApiSecurityRequirementObject)

const OpenApiServerVariable = Schema.Struct({ default: Schema.String })
const OpenApiServer = Schema.Struct({
  url: Schema.String,
  variables: Schema.optional(Schema.Record(Schema.String, OpenApiServerVariable))
})

const OpenApiOperationObject = Schema.Struct({
  operationId: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  parameters: Schema.optional(Schema.Array(OpenApiParameterValue)),
  requestBody: Schema.optional(OpenApiRequestBodyValue),
  responses: Schema.optional(Schema.Record(Schema.String, OpenApiResponseValue)),
  security: Schema.optional(OpenApiSecurityRequirements),
  servers: Schema.optional(Schema.Array(OpenApiServer))
})

const OpenApiPathItem = Schema.Struct({
  parameters: Schema.optional(Schema.Array(OpenApiParameterValue)),
  servers: Schema.optional(Schema.Array(OpenApiServer)),
  delete: Schema.optional(OpenApiOperationObject),
  get: Schema.optional(OpenApiOperationObject),
  head: Schema.optional(OpenApiOperationObject),
  options: Schema.optional(OpenApiOperationObject),
  patch: Schema.optional(OpenApiOperationObject),
  post: Schema.optional(OpenApiOperationObject),
  put: Schema.optional(OpenApiOperationObject)
})

const OpenApiOAuthFlow = Schema.Struct({
  scopes: Schema.Record(Schema.String, Schema.String)
})
const OpenApiOAuthFlows = Schema.Struct({
  authorizationCode: Schema.optional(OpenApiOAuthFlow),
  clientCredentials: Schema.optional(OpenApiOAuthFlow),
  implicit: Schema.optional(OpenApiOAuthFlow),
  password: Schema.optional(OpenApiOAuthFlow)
})
const OpenApiSecuritySchemeObject = Schema.Struct({
  type: Schema.String,
  scheme: Schema.optional(Schema.String),
  bearerFormat: Schema.optional(Schema.String),
  in: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  openIdConnectUrl: Schema.optional(Schema.String),
  flows: Schema.optional(OpenApiOAuthFlows)
})
const OpenApiSecuritySchemeValue = Schema.Union([OpenApiSecuritySchemeObject, OpenApiReference])

const OpenApiDocument = Schema.Struct({
  openapi: Schema.String,
  info: Schema.optional(Schema.Struct({
    title: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String)
  })),
  servers: Schema.optional(Schema.Array(OpenApiServer)),
  paths: Schema.Record(Schema.String, OpenApiPathItem),
  security: Schema.optional(OpenApiSecurityRequirements),
  components: Schema.optional(Schema.Struct({
    securitySchemes: Schema.optional(Schema.Record(Schema.String, OpenApiSecuritySchemeValue)),
    parameters: Schema.optional(Schema.Record(Schema.String, OpenApiParameterValue))
  }))
})
type OpenApiDocument = typeof OpenApiDocument.Type
type OpenApiOperationObject = typeof OpenApiOperationObject.Type
type OpenApiParameterValue = typeof OpenApiParameterValue.Type
type OpenApiRequestBodyValue = typeof OpenApiRequestBodyValue.Type
type OpenApiResponseValue = typeof OpenApiResponseValue.Type
type OpenApiServer = typeof OpenApiServer.Type

const isReference = (
  value: OpenApiParameterValue | OpenApiRequestBodyValue | OpenApiResponseValue | typeof OpenApiSecuritySchemeValue.Type
): value is typeof OpenApiReference.Type => "$ref" in value

const parameterLocation = (value: string): OpenApiParameterLocation => {
  switch (value) {
    case "path":
    case "query":
    case "header":
    case "cookie":
      return value
    default:
      throw new Error(`Unsupported OpenAPI parameter location: ${value}`)
  }
}

const referenceName = (reference: string): string => {
  const segments = reference.split("/")
  return segments[segments.length - 1] ?? reference
}

const toParameter = (
  value: OpenApiParameterValue,
  document: OpenApiDocument,
  seen: ReadonlySet<string> = new Set()
): OpenApiParameter => {
  if (isReference(value)) {
    const prefix = "#/components/parameters/"
    if (value.$ref.startsWith(prefix) && !seen.has(value.$ref)) {
      const encodedName = value.$ref.slice(prefix.length)
      const name = encodedName.replaceAll("~1", "/").replaceAll("~0", "~")
      const target = document.components?.parameters?.[name]
      if (target !== undefined) {
        return {
          ...toParameter(target, document, new Set([...seen, value.$ref])),
          reference: value.$ref
        }
      }
    }
    return {
      name: referenceName(value.$ref),
      location: "reference",
      required: false,
      reference: value.$ref
    }
  }
  const location = parameterLocation(value.in)
  return {
    name: value.name,
    location,
    required: location === "path" || value.required === true,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.schema === undefined ? {} : { schema: value.schema })
  }
}

const selectedMediaType = (
  content: typeof OpenApiContent.Type | undefined
): { readonly contentTypes: ReadonlyArray<string>; readonly schema?: typeof Schema.Json.Type } => {
  if (content === undefined) return { contentTypes: [] }
  const contentTypes = Object.keys(content)
  const preferred = content["application/json"] ?? content[contentTypes[0] ?? ""]
  return {
    contentTypes,
    ...(preferred?.schema === undefined ? {} : { schema: preferred.schema })
  }
}

const toRequestBody = (value: OpenApiRequestBodyValue): OpenApiRequestBody => {
  if (isReference(value)) {
    return { required: false, contentTypes: [], reference: value.$ref }
  }
  return {
    required: value.required === true,
    ...selectedMediaType(value.content)
  }
}

const toResponse = (status: string, value: OpenApiResponseValue): OpenApiResponse => {
  if (isReference(value)) {
    return { status, contentTypes: [], reference: value.$ref }
  }
  return {
    status,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...selectedMediaType(value.content)
  }
}

const toSecurity = (
  value: typeof OpenApiSecurityRequirements.Type | undefined
): ReadonlyArray<OpenApiSecurityRequirement> => (value ?? []).map((requirement) => ({
  schemes: Object.entries(requirement).map(([name, scopes]) => ({ name, scopes }))
}))

const serverUrl = (server: OpenApiServer | undefined, specUrl: URL): string => {
  if (server === undefined) return new URL("/", specUrl).toString().replace(/\/$/, "")
  const expanded = Object.entries(server.variables ?? {}).reduce(
    (url, [name, variable]) => url.replaceAll(`{${name}}`, variable.default),
    server.url
  )
  return new URL(expanded, specUrl).toString().replace(/\/$/, "")
}

const methodEntries = (pathItem: typeof OpenApiPathItem.Type): ReadonlyArray<readonly [OpenApiHttpMethod, OpenApiOperationObject]> => {
  const entries: Array<readonly [OpenApiHttpMethod, OpenApiOperationObject]> = []
  if (pathItem.delete !== undefined) entries.push(["DELETE", pathItem.delete])
  if (pathItem.get !== undefined) entries.push(["GET", pathItem.get])
  if (pathItem.head !== undefined) entries.push(["HEAD", pathItem.head])
  if (pathItem.options !== undefined) entries.push(["OPTIONS", pathItem.options])
  if (pathItem.patch !== undefined) entries.push(["PATCH", pathItem.patch])
  if (pathItem.post !== undefined) entries.push(["POST", pathItem.post])
  if (pathItem.put !== undefined) entries.push(["PUT", pathItem.put])
  return entries
}

const operationsFromDocument = (document: OpenApiDocument, specUrl: URL): ReadonlyArray<OpenApiOperation> => {
  const operations: Array<OpenApiOperation> = []
  for (const [operationPath, pathItem] of Object.entries(document.paths)) {
    for (const [method, operation] of methodEntries(pathItem)) {
      const parameters = Array.from(new Map(
        [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
          .map((parameter) => toParameter(parameter, document))
          .map((parameter) => [`${parameter.location}\0${parameter.name}`, parameter])
      ).values())
      operations.push({
        operationId: operation.operationId ?? `${method} ${operationPath}`,
        method,
        path: operationPath,
        server: serverUrl(operation.servers?.[0] ?? pathItem.servers?.[0] ?? document.servers?.[0], specUrl),
        ...(operation.summary === undefined ? {} : { summary: operation.summary }),
        ...(operation.description === undefined ? {} : { description: operation.description }),
        parameters,
        ...(operation.requestBody === undefined ? {} : { requestBody: toRequestBody(operation.requestBody) }),
        responses: Object.entries(operation.responses ?? {}).map(([status, response]) => toResponse(status, response)),
        security: toSecurity(operation.security ?? document.security)
      })
    }
  }
  return operations
}

const securitySchemesFromDocument = (document: OpenApiDocument): ReadonlyArray<OpenApiSecurityScheme> =>
  Object.entries(document.components?.securitySchemes ?? {}).map(([name, value]) => {
    if (isReference(value)) {
      return { name, type: "reference", scopes: [], reference: value.$ref }
    }
    const scopes = Object.keys({
      ...(value.flows?.authorizationCode?.scopes ?? {}),
      ...(value.flows?.clientCredentials?.scopes ?? {}),
      ...(value.flows?.implicit?.scopes ?? {}),
      ...(value.flows?.password?.scopes ?? {})
    })
    return {
      name,
      type: value.type,
      ...(value.scheme === undefined ? {} : { scheme: value.scheme }),
      ...(value.bearerFormat === undefined ? {} : { bearerFormat: value.bearerFormat }),
      ...(value.in === undefined ? {} : { location: value.in }),
      ...(value.name === undefined ? {} : { parameterName: value.name }),
      ...(value.openIdConnectUrl === undefined ? {} : { openIdConnectUrl: value.openIdConnectUrl }),
      scopes
    }
  })

const documentHash = async (text: string): Promise<string> => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Buffer.from(hash).toString("base64url")
}

const parseDocument = (text: string, contentType: string): OpenApiDocument => {
  let decoded: typeof Schema.Json.Type
  try {
    const parsed = contentType.includes("json") || text.trimStart().startsWith("{")
      ? JSON.parse(text)
      : parseYaml(text)
    decoded = Schema.decodeUnknownSync(Schema.Json)(parsed)
  } catch (error) {
    throw new Error(`OpenAPI document is not valid JSON or YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  return Schema.decodeUnknownSync(OpenApiDocument)(decoded)
}

export const discoverOpenApi = async (specValue: string): Promise<OpenApiDiscovery> => {
  let specUrl: URL
  try {
    specUrl = new URL(specValue)
  } catch {
    throw new Error(`OpenAPI spec URL is invalid: ${specValue}`)
  }
  if (specUrl.protocol !== "https:" && specUrl.protocol !== "http:") {
    throw new Error("OpenAPI spec URL must use HTTP or HTTPS")
  }
  const response = await fetch(specUrl, { headers: { accept: "application/json, application/yaml, text/yaml" } })
  if (!response.ok) {
    throw new Error(`OpenAPI discovery failed: ${response.status} ${response.statusText}`)
  }
  const text = await response.text()
  const document = parseDocument(text, response.headers.get("content-type") ?? "")
  if (!document.openapi.startsWith("3.")) {
    throw new Error(`Unsupported OpenAPI version ${document.openapi}; wf currently supports OpenAPI 3.x`)
  }
  return {
    specUrl: specUrl.toString(),
    specHash: await documentHash(text),
    openapi: document.openapi,
    ...(document.info?.title === undefined ? {} : { title: document.info.title }),
    ...(document.info?.version === undefined ? {} : { version: document.info.version }),
    operations: operationsFromDocument(document, specUrl),
    securitySchemes: securitySchemesFromDocument(document)
  }
}
