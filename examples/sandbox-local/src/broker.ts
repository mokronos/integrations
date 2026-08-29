import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { OAuthSession } from "@mokronos/integrations-client"
import { Option, Schema } from "effect"

const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

const BrokerUrl = Schema.URLFromString.pipe(Schema.brand("BrokerUrl"))
export type BrokerUrl = typeof BrokerUrl.Type

const GatewayUrl = Schema.URLFromString.pipe(Schema.brand("GatewayUrl"))
export type GatewayUrl = typeof GatewayUrl.Type

const ApiKey = Schema.NonEmptyString.pipe(Schema.brand("ApiKey"))
export type ApiKey = typeof ApiKey.Type

export const decodeGatewayUrl = Schema.decodeUnknownSync(GatewayUrl)
const decodeBrokerUrl = Schema.decodeUnknownSync(BrokerUrl)
export const decodeApiKey = Schema.decodeUnknownSync(ApiKey)

export const OAuthRequest = Schema.Struct({
  integration: Schema.String,
  connection: Schema.optional(Schema.String)
})
export type OAuthRequest = typeof OAuthRequest.Type

export const OAuthPrompt = Schema.Struct({
  sessionId: Schema.String,
  integration: Schema.String,
  connection: Schema.String,
  authorizationUrl: Schema.URL
})
export type OAuthPrompt = typeof OAuthPrompt.Type

const decodeOAuthRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(OAuthRequest)
)
const decodeOAuthSession = Schema.decodeUnknownOption(
  Schema.fromJsonString(OAuthSession)
)
const decodeAuthorizationUrl = Schema.decodeUnknownOption(Schema.URLFromString)

const allowedRoutes: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/v1\/(?:health|metadata)$/],
  ["GET", /^\/v1\/registry\/search$/],
  ["GET", /^\/v1\/integrations$/],
  ["POST", /^\/v1\/integrations\/discover$/],
  ["GET", /^\/v1\/integrations\/[^/]+\/tools(?:\/[^/]+)?$/],
  ["POST", /^\/v1\/validate$/],
  ["GET", /^\/v1\/connections$/],
  ["POST", /^\/v1\/connections$/],
  ["POST", /^\/v1\/connections\/oauth$/],
  ["GET", /^\/v1\/connections\/oauth\/[^/]+$/],
  ["DELETE", /^\/v1\/connections\/[^/]+\/[^/]+$/],
  ["GET", /^\/v1\/tools$/],
  ["POST", /^\/v1\/execute$/],
  ["GET", /^\/v1\/approvals\/[^/]+$/]
]

const requestHeaderNames = ["accept", "content-type", "user-agent"] as const
const responseHeaderNames = ["cache-control", "content-type", "retry-after"] as const

const jsonError = (status: number, error: string): Response =>
  Response.json({ error }, { status })

const contentLength = (headers: Headers): number | undefined => {
  const value = headers.get("content-length")
  if (value === null) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

const copyHeaders = (
  source: Headers,
  names: ReadonlyArray<string>
): Headers => {
  const result = new Headers()
  for (const name of names) {
    const value = source.get(name)
    if (value !== null) result.set(name, value)
  }
  return result
}

export const isAllowedBrokerRoute = (method: string, pathname: string): boolean =>
  allowedRoutes.some(([allowedMethod, pattern]) =>
    method === allowedMethod && pattern.test(pathname)
  )

export interface GatewayBrokerOptions {
  readonly gatewayUrl: GatewayUrl
  readonly apiKey: ApiKey
  readonly onOAuthPrompt: (prompt: OAuthPrompt) => void
  readonly fetch?: typeof globalThis.fetch
}

export interface GatewayBroker {
  readonly url: BrokerUrl
  readonly port: number
  close(): Promise<void>
}

const decodeStreamChunk = Schema.decodeUnknownSync(Schema.Uint8Array)
const BrokerAddress = Schema.Struct({ port: Schema.Int })
const decodeBrokerAddress = Schema.decodeUnknownOption(BrokerAddress)

const readIncomingBody = async (
  request: IncomingMessage
): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  const chunks: Array<Uint8Array<ArrayBufferLike>> = []
  let length = 0
  for await (const input of request) {
    const chunk = decodeStreamChunk(input)
    length += chunk.byteLength
    if (length > MAX_REQUEST_BYTES) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return new Uint8Array()
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

const requestHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers()
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]
    const value = request.rawHeaders[index + 1]
    if (name !== undefined && value !== undefined) headers.append(name, value)
  }
  return headers
}

const sendNodeResponse = async (
  target: ServerResponse,
  response: Response
): Promise<void> => {
  target.statusCode = response.status
  response.headers.forEach((value, name) => target.setHeader(name, value))
  target.end(new Uint8Array(await response.arrayBuffer()))
}

const oauthPromptFrom = (
  requestBody: string,
  responseBody: string
): OAuthPrompt | undefined => {
  const request = decodeOAuthRequest(requestBody)
  const session = decodeOAuthSession(responseBody)
  if (Option.isNone(request) || Option.isNone(session)) return undefined
  if (session.value.state.status !== "pending") return undefined
  if (request.value.integration !== session.value.integration) return undefined
  const authorizationUrl = decodeAuthorizationUrl(session.value.state.authorizationUrl)
  if (Option.isNone(authorizationUrl)) return undefined
  return {
    sessionId: session.value.id,
    integration: session.value.integration,
    connection: session.value.connection,
    authorizationUrl: authorizationUrl.value
  }
}

export const startGatewayBroker = async (
  options: GatewayBrokerOptions
): Promise<GatewayBroker> => {
  const doFetch = options.fetch ?? globalThis.fetch
  const gatewayOrigin = options.gatewayUrl.href.replace(/\/+$/, "")

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (!isAllowedBrokerRoute(request.method, url.pathname)) {
      return jsonError(403, "Route is not available to the sandbox")
    }

    const declaredLength = contentLength(request.headers)
    if (declaredLength !== undefined && declaredLength > MAX_REQUEST_BYTES) {
      return jsonError(413, "Request body is too large")
    }

    const requestBody = request.body === null
      ? undefined
      : new Uint8Array(await request.arrayBuffer())
    if (requestBody !== undefined && requestBody.byteLength > MAX_REQUEST_BYTES) {
      return jsonError(413, "Request body is too large")
    }

    const headers = copyHeaders(request.headers, requestHeaderNames)
    headers.set("authorization", `Bearer ${options.apiKey}`)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    let upstream: Response
    try {
      const init: RequestInit = {
        method: request.method,
        headers,
        redirect: "manual",
        signal: controller.signal
      }
      if (requestBody !== undefined) init.body = requestBody
      upstream = await doFetch(`${gatewayOrigin}${url.pathname}${url.search}`, init)
    } catch {
      return jsonError(502, "Gateway request failed")
    } finally {
      clearTimeout(timeout)
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      return jsonError(502, "Gateway redirects are not accepted")
    }

    const declaredResponseLength = contentLength(upstream.headers)
    if (declaredResponseLength !== undefined && declaredResponseLength > MAX_RESPONSE_BYTES) {
      return jsonError(502, "Gateway response is too large")
    }
    const responseBody = new Uint8Array(await upstream.arrayBuffer())
    if (responseBody.byteLength > MAX_RESPONSE_BYTES) {
      return jsonError(502, "Gateway response is too large")
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/connections/oauth" &&
      upstream.ok &&
      requestBody !== undefined
    ) {
      const prompt = oauthPromptFrom(
        new TextDecoder().decode(requestBody),
        new TextDecoder().decode(responseBody)
      )
      if (prompt !== undefined) queueMicrotask(() => options.onOAuthPrompt(prompt))
    }

    return new Response(responseBody, {
      status: upstream.status,
      headers: copyHeaders(upstream.headers, responseHeaderNames)
    })
  }

  const server = createServer((incoming, outgoing) => {
    const target = incoming.url ?? "/"
    if (/^(?:https?:)?\/\//i.test(target)) {
      sendNodeResponse(outgoing, jsonError(400, "Absolute request targets are not accepted"))
        .catch(() => outgoing.destroy())
      return
    }
    const declaredLength = contentLength(requestHeaders(incoming))
    if (declaredLength !== undefined && declaredLength > MAX_REQUEST_BYTES) {
      sendNodeResponse(outgoing, jsonError(413, "Request body is too large"))
        .catch(() => outgoing.destroy())
      return
    }
    readIncomingBody(incoming).then(async (body) => {
      if (body === undefined) {
        await sendNodeResponse(outgoing, jsonError(413, "Request body is too large"))
        return
      }
      const method = incoming.method ?? "GET"
      const init: RequestInit = {
        method,
        headers: requestHeaders(incoming)
      }
      if (method !== "GET" && method !== "HEAD") init.body = body
      const request = new Request(`http://sandbox.invalid${target}`, init)
      await sendNodeResponse(outgoing, await handle(request))
    }).catch(() => {
      if (!outgoing.headersSent) {
        outgoing.statusCode = 500
        outgoing.end('{"error":"Broker request failed"}')
      } else {
        outgoing.destroy()
      }
    })
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.maxHeadersCount = 64
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = decodeBrokerAddress(server.address())
  if (Option.isNone(address)) {
    server.close()
    throw new Error("Gateway broker did not bind a TCP port")
  }
  const port = address.value.port

  return {
    url: decodeBrokerUrl(`http://127.0.0.1:${port}`),
    port,
    close: async () => {
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
      })
    }
  }
}
