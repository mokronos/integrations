import { Option } from "effect"
import type { HttpMethod } from "effect/unstable/http"
import { isJsonObject, isJsonString, type Json } from "@mokronos/contracts"
import type { CallParameter, HttpCall, HttpMethod as CallMethod } from "@mokronos/core-integrations"

export interface BuiltRequest {
  readonly url: string
  readonly method: HttpMethod.HttpMethod
  readonly headers: Readonly<Record<string, string>>
  readonly body: Option.Option<string>
}

const requestMethods = {
  get: "GET",
  put: "PUT",
  post: "POST",
  delete: "DELETE",
  patch: "PATCH",
  head: "HEAD",
  options: "OPTIONS",
  trace: "TRACE"
} as const satisfies Record<CallMethod, HttpMethod.HttpMethod>

const scalar = (value: Json): string => {
  if (value === null) return ""
  if (isJsonString(value)) return value
  if (Array.isArray(value) || isJsonObject(value)) return JSON.stringify(value)
  return String(value)
}

const entriesOf = (value: Json): ReadonlyArray<readonly [string, Json]> =>
  isJsonObject(value) ? Object.entries(value) : []

const delimiter = (style: string): string => {
  switch (style) {
    case "spaceDelimited": return " "
    case "pipeDelimited": return "|"
    default: return ","
  }
}

const queryPairs = (
  parameter: CallParameter,
  value: Json
): ReadonlyArray<readonly [string, string]> => {
  const { name, style, explode } = parameter

  if (Array.isArray(value)) {
    return explode
      ? value.map((entry) => [name, scalar(entry)] as const)
      : [[name, value.map(scalar).join(delimiter(style))] as const]
  }

  if (isJsonObject(value)) {
    const entries = entriesOf(value)
    if (style === "deepObject") {
      return entries.map(([key, entry]) => [`${name}[${key}]`, scalar(entry)] as const)
    }
    if (explode) {
      return entries.map(([key, entry]) => [key, scalar(entry)] as const)
    }
    return [[
      name,
      entries.flatMap(([key, entry]) => [key, scalar(entry)]).join(",")
    ] as const]
  }

  return [[name, scalar(value)] as const]
}

const pathSegment = (parameter: CallParameter, value: Json): string => {
  const encode = (entry: Json): string => encodeURIComponent(scalar(entry))

  if (Array.isArray(value)) {
    const joined = value.map(encode)
    switch (parameter.style) {
      case "label":
        return parameter.explode ? `.${joined.join(".")}` : `.${joined.join(",")}`
      case "matrix":
        return parameter.explode
          ? joined.map((entry) => `;${parameter.name}=${entry}`).join("")
          : `;${parameter.name}=${joined.join(",")}`
      default:
        return joined.join(",")
    }
  }

  if (isJsonObject(value)) {
    const entries = entriesOf(value)
    const flat = entries.flatMap(([key, entry]) => [key, scalar(entry)]).map(encodeURIComponent)
    const exploded = entries
      .map(([key, entry]) => `${encodeURIComponent(key)}=${encode(entry)}`)
    switch (parameter.style) {
      case "label":
        return parameter.explode ? `.${exploded.join(".")}` : `.${flat.join(",")}`
      case "matrix":
        return parameter.explode
          ? `;${exploded.join(";")}`
          : `;${parameter.name}=${flat.join(",")}`
      default:
        return parameter.explode ? exploded.join(",") : flat.join(",")
    }
  }

  const single = encode(value)
  switch (parameter.style) {
    case "label": return `.${single}`
    case "matrix": return `;${parameter.name}=${single}`
    default: return single
  }
}

const jsonContentType = /^application\/(?:[\w.+-]+\+)?json\b/i

const encodeBody = (
  call: HttpCall,
  body: Json
): Option.Option<string> => {
  const contentType = call.contentType ?? "application/json"
  if (/^application\/x-www-form-urlencoded\b/i.test(contentType)) {
    const encoded = new URLSearchParams()
    for (const [key, value] of entriesOf(body)) encoded.append(key, scalar(value))
    return Option.some(encoded.toString())
  }
  if (jsonContentType.test(contentType)) return Option.some(JSON.stringify(body))
  return Option.some(isJsonString(body) ? body : JSON.stringify(body))
}

export interface BuildRequestOptions {
  readonly call: HttpCall
  readonly server: string
  readonly parameters: Readonly<Record<string, Json>>
  readonly requestBody: Option.Option<Json>
}

export const buildRequest = (options: BuildRequestOptions): BuiltRequest => {
  const call = options.call
  const declared = new Map(call.parameters.map((parameter) => [parameter.name, parameter]))
  const base = options.server.replace(/\/+$/, "")

  const path = call.path.replace(/\{([^{}]+)\}/g, (whole, name: string) => {
    const parameter = declared.get(name)
    const value = options.parameters[name]
    if (parameter === undefined || value === undefined) return whole
    return pathSegment(parameter, value)
  })

  const query = new URLSearchParams()
  const headers: Record<string, string> = {}

  for (const [name, value] of Object.entries(options.parameters)) {
    const parameter = declared.get(name)
    if (parameter === undefined || value === undefined) continue
    switch (parameter.location) {
      case "path":
        break
      case "query":
        for (const [key, rendered] of queryPairs(parameter, value)) {
          query.append(key, rendered)
        }
        break
      case "header":
        headers[name] = Array.isArray(value)
          ? value.map(scalar).join(",")
          : scalar(value)
        break
      case "cookie":
        headers["cookie"] = [headers["cookie"], `${name}=${scalar(value)}`]
          .filter((entry) => entry !== undefined && entry.length > 0)
          .join("; ")
        break
      case "body":
        break
    }
  }

  const body = Option.flatMap(options.requestBody, (value) => encodeBody(call, value))
  if (Option.isSome(body)) {
    headers["content-type"] = call.contentType ?? "application/json"
  }

  const search = query.toString()
  return {
    url: `${base}${path.startsWith("/") ? path : `/${path}`}${search.length === 0 ? "" : `?${search}`}`,
    method: requestMethods[call.method],
    headers,
    body
  }
}
