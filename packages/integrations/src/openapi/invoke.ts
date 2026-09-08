import { buildRequest } from "./request.ts"
import { Context, Effect, Layer, Option } from "effect"
import { describeCause, InvocationError, SpecError } from "../errors.ts"
import type { HttpCall } from "@mokronos/core-integrations"
import { missingArguments, splitArguments } from "./arguments.ts"
import { whenPresent } from "@mokronos/contracts"
import { AuthPlacement } from "@mokronos/contracts"
import { parseJsonString, type Json } from "@mokronos/contracts"
import { HttpTransport } from "../http-transport.ts"


export interface ResolvedCredential {
  readonly value: string
  readonly placements: ReadonlyArray<AuthPlacement>
}

const bearerPlacement: AuthPlacement = {
  carrier: "header",
  name: "Authorization",
  prefix: "Bearer "
}

const applyCredential = (
  request: { readonly url: string; readonly headers: Record<string, string> },
  credential: Option.Option<ResolvedCredential>
): { readonly url: string; readonly headers: Record<string, string> } =>
  Option.match(credential, {
    onNone: () => request,
    onSome: (resolved) => {
      const placements = resolved.placements.length === 0
        ? [bearerPlacement]
        : resolved.placements
      const url = new URL(request.url)
      const headers = { ...request.headers }
      for (const placement of placements) {
        const rendered = `${placement.prefix}${resolved.value}`
        switch (placement.carrier) {
          case "header":
            headers[placement.name] = rendered
            break
          case "query":
            url.searchParams.set(placement.name, rendered)
            break
          case "env":
            break
        }
      }
      return { url: url.toString(), headers }
    }
  })

const jsonContentType = /^application\/(?:[\w.+-]+\+)?json\b/i
const ndjsonContentType = /^application\/(?:x-)?nd-?json\b/i

const decodeBody = (
  contentType: string,
  body: string
): Json => {
  if (body.length === 0) return null
  if (ndjsonContentType.test(contentType)) {
    return body
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => Option.getOrElse(parseJsonString(line), (): Json => line))
  }
  if (jsonContentType.test(contentType)) {
    return Option.getOrElse(parseJsonString(body), (): Json => body)
  }
  return body
}

const errorDetail = (body: string): string => {
  const trimmed = body.trim()
  if (trimmed.length === 0) return "no response body"
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed
}

export interface OpenApiCall {
  readonly call: HttpCall
  readonly tool: string
  readonly server: string
  readonly input: Json
  readonly credential: Option.Option<ResolvedCredential>
  readonly timeoutMillis?: number
}

const defaultTimeoutMillis = 60_000

export class OpenApiInvoker extends Context.Service<
  OpenApiInvoker,
  {
    readonly call: (
      call: OpenApiCall
    ) => Effect.Effect<Json, InvocationError | SpecError>
  }
>()("@mokronos/integrations/OpenApiInvoker") {
  static readonly layer: Layer.Layer<OpenApiInvoker, never, HttpTransport> = Layer.effect(
    OpenApiInvoker,
    Effect.gen(function* () {
      const transport = yield* HttpTransport
      return {
      call: Effect.fn("OpenApiInvoker.call")(function* (call: OpenApiCall) {
        const split = splitArguments(call.call, call.input)
        if (split.unknown.length > 0) {
          return yield* new InvocationError({
            code: "unknown_argument",
            detail: `${call.tool} does not accept: ${split.unknown.join(", ")}`
          })
        }
        const missing = missingArguments(call.call, split.parameters)
        if (missing.length > 0) {
          return yield* new InvocationError({
            code: "missing_argument",
            detail: `${call.tool} requires: ${missing.join(", ")}`
          })
        }

        const built = yield* Effect.try({
          try: () => buildRequest({
            call: call.call,
            server: call.server,
            parameters: split.parameters,
            requestBody: split.requestBody
          }),
          catch: (cause) => new SpecError({
            source: call.tool,
            detail: `Could not build the request: ${describeCause(cause)}`,
            cause
          })
        })

        const prepared = applyCredential(
          { url: built.url, headers: { ...built.headers } },
          call.credential
        )

        const response = yield* Effect.tryPromise({
          try: () => transport.fetch(prepared.url, {
            method: built.method,
            headers: { accept: "application/json, */*", ...prepared.headers },
            ...whenPresent("body", Option.getOrUndefined(built.body))
          }),
          catch: (cause) => new InvocationError({
            code: "transport_error",
            detail: describeCause(cause)
          })
        }).pipe(
          Effect.timeoutOrElse({
            duration: call.timeoutMillis ?? defaultTimeoutMillis,
            orElse: () => Effect.fail(new InvocationError({
              code: "timeout",
              detail: `${call.tool} did not answer in time`
            }))
          })
        )

        const contentType = response.headers.get("content-type") ?? ""
        const body = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) => new InvocationError({
            code: "response_error",
            detail: describeCause(cause),
            status: response.status
          })
        })

        if (!response.ok) {
          return yield* new InvocationError({
            code: `http_${response.status}`,
            detail: errorDetail(body),
            status: response.status
          })
        }

        return decodeBody(contentType, body)
      })
      }
    })
  )

  static readonly unavailableTestLayer: Layer.Layer<OpenApiInvoker> = Layer.succeed(
    OpenApiInvoker,
    { call: () => Effect.die("Unexpected OpenAPI invocation") }
  )
}
