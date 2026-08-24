import { buildRequest } from "./request.ts"
import { Context, Effect, Layer, Option } from "effect"
import { describeCause, InvocationError, SpecError } from "./errors.ts"
import type { CompiledOperation, CompiledSpec } from "./openapi.ts"
import { resolveServer, splitInput } from "./openapi.ts"
import { whenPresent } from "./optional.ts"
import { ExecutorAuthPlacement } from "./schemas.ts"
import { parseJsonString, type Json } from "./json.ts"

/** Performing an OpenAPI call.
 *
 *  The request itself is built next door; what happens here is the rest of a
 *  call: put the tenant's credential where the integration wants it, run the
 *  request under a timeout, and turn the response into the JSON a tool result is
 *  made of. */


/** A resolved secret plus the places the integration said to put it. */
export interface ResolvedCredential {
  readonly value: string
  readonly placements: ReadonlyArray<ExecutorAuthPlacement>
}

/** The default when an integration declares no placement: a bearer header. It
 *  is what an OAuth grant and the overwhelming majority of API keys want. */
const bearerPlacement: ExecutorAuthPlacement = {
  carrier: "header",
  name: "Authorization",
  prefix: "Bearer "
}

/** Applies every placement to the built request. `query` placements move the
 *  secret into the URL, which is why a document that offers a header carrier is
 *  always preferred when installing an integration. */
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
            // An `env` carrier describes a process the host does not run: there
            // is no child to hand an environment to. Ignored rather than
            // silently promoted to a header, which would leak the secret to a
            // place the integration never nominated.
            break
        }
      }
      return { url: url.toString(), headers }
    }
  })

const jsonContentType = /^application\/(?:[\w.+-]+\+)?json\b/i
const ndjsonContentType = /^application\/(?:x-)?nd-?json\b/i

/** Turns a response body into a tool result.
 *
 *  A tool's caller wants data, so a JSON body decodes and anything else comes
 *  back as text rather than failing — an integration that answers `text/csv` is
 *  still answering. */
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

/** The upstream's own error text, trimmed to something an audit record can
 *  hold without becoming a dump. */
const errorDetail = (body: string): string => {
  const trimmed = body.trim()
  if (trimmed.length === 0) return "no response body"
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed
}

export interface OpenApiCall {
  readonly spec: CompiledSpec
  readonly operation: CompiledOperation
  readonly input: Json
  /** Where the document was fetched from. A document may declare a relative
   *  server — Swagger's own petstore says `/api/v3` — which is only resolvable
   *  against this, so it is what makes such a document callable at all. */
  readonly specSource: Option.Option<string>
  /** Replaces the document's server entirely, for a deployment that hosts the
   *  same API somewhere else. */
  readonly baseUrl: Option.Option<string>
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
>()("@mokronos/integrations-executor/OpenApiInvoker") {
  static readonly layer: Layer.Layer<OpenApiInvoker> = Layer.effect(
    OpenApiInvoker,
    Effect.sync(() => ({
      call: Effect.fn("OpenApiInvoker.call")(function* (call: OpenApiCall) {
        const split = splitInput(call.operation, call.input)
        if (split.unknown.length > 0) {
          return yield* new InvocationError({
            code: "unknown_argument",
            detail: `${call.operation.name} does not accept: ${split.unknown.join(", ")}`
          })
        }

        // A missing required parameter would otherwise leave its `{placeholder}`
        // in the path, or silently drop a required filter — a request the
        // upstream rejects for reasons that do not name the real problem.
        const missing = call.operation.parameters
          .filter((parameter) =>
            parameter.required && split.parameters[parameter.name] === undefined
          )
          .map((parameter) => parameter.name)
        if (missing.length > 0) {
          return yield* new InvocationError({
            code: "missing_argument",
            detail: `${call.operation.name} requires: ${missing.join(", ")}`
          })
        }

        const server = resolveServer(call.spec, {
          baseUrl: call.baseUrl,
          specSource: call.specSource
        })
        if (Option.isNone(server)) {
          return yield* new SpecError({
            source: call.operation.name,
            detail: "The document declares no server, and none was configured"
          })
        }

        const built = yield* Effect.try({
          try: () => buildRequest({
            spec: call.spec,
            operation: call.operation,
            server: server.value,
            parameters: split.parameters,
            requestBody: split.requestBody
          }),
          catch: (cause) => new SpecError({
            source: call.operation.name,
            detail: `Could not build the request: ${describeCause(cause)}`,
            cause
          })
        })

        const prepared = applyCredential(
          { url: built.url, headers: { ...built.headers } },
          call.credential
        )

        const response = yield* Effect.tryPromise({
          try: () => fetch(prepared.url, {
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
              detail: `${call.operation.name} did not answer in time`
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
    }))
  )
}
