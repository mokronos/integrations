import { Option } from "effect"
import { isJsonObject, isJsonString, type Json } from "@mokronos/contracts"
import type { CallParameter, HttpCall } from "@mokronos/core-integrations"

/** Turning an operation and a caller's arguments into an HTTP request.
 *
 *  This was `swagger-client.buildRequest`, which does the job well — but it
 *  pulls in the 39-package `@swagger-api/apidom-*` tree for its parsing and
 *  resolving features, adding about 2.5 MB to a bundle that ships to Cloudflare
 *  Workers, and we use none of them. The part we did use is the serialisation
 *  OpenAPI specifies for parameter styles, which is a closed, written-down set
 *  of rules over data we already hold: every parameter's style and explode flag
 *  comes off the compiled operation.
 *
 *  The rules are OpenAPI's `style`/`explode` table, which is RFC 6570 template
 *  expansion restricted to the combinations OpenAPI allows. */

export interface BuiltRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Option.Option<string>
}

/** How a value renders on its own. `null` is the empty string, because a
 *  parameter's absence is expressed by omitting it rather than by sending
 *  `null`. */
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

/** One query parameter, as the name/value pairs it contributes.
 *
 *  Returning pairs rather than a string is what lets `URLSearchParams` do the
 *  percent-encoding: encoding by hand is where this kind of code goes wrong. */
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

/** One path parameter's replacement text. Percent-encoded here rather than by
 *  the URL parser, because a `/` inside a value must not become a segment
 *  boundary. */
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

/** Encodes the request body in the media type the operation declares. */
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
  // A media type this host does not encode — `text/plain`, an upload — takes
  // the value as it stands rather than being wrapped in JSON quotes.
  return Option.some(isJsonString(body) ? body : JSON.stringify(body))
}

export interface BuildRequestOptions {
  /** How to perform this tool, as captured. */
  readonly call: HttpCall
  /** The absolute origin, and any base path, the request goes to. Server
   *  variables were resolved at capture, so this needs no further filling in. */
  readonly server: string
  readonly parameters: Readonly<Record<string, Json>>
  readonly requestBody: Option.Option<Json>
}

export const buildRequest = (options: BuildRequestOptions): BuiltRequest => {
  const call = options.call
  const declared = new Map(call.parameters.map((parameter) => [parameter.name, parameter]))
  const base = options.server.replace(/\/+$/, "")

  // Path parameters are substituted into the template, so an unsupplied one
  // leaves its placeholder visible in the failing URL rather than silently
  // collapsing two segments together.
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
    method: call.method.toUpperCase(),
    headers,
    body
  }
}
