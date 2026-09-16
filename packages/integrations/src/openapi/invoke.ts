import { buildRequest } from "./request.ts"
import { Context, Effect, Layer, Option, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { describeCause, InvocationError, SpecError, StorageError } from "../errors.ts"
import type { HttpCall } from "../tool.ts"
import { missingArguments, splitArguments } from "./arguments.ts"
import { AuthPlacement } from "@integrations/contracts"
import { parseJsonString, whenPresent, type Json } from "@integrations/contracts"
import {
  binaryNote,
  blobHandleKey,
  defaultMaxInlineBytes,
  filenameFromDisposition,
  isTextualContentType,
  oversizeNote
} from "@integrations/contracts"
import { BlobStore } from "../storage/blobs.ts"

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

const errorDetail = (contentType: string, body: string): string => {
  const trimmed = body.trim()
  if (trimmed.length === 0) return "no response body"
  // An API answering HTML is an API that was never reached, and its error page
  // is worth less to the caller than knowing that is what happened.
  if (!jsonContentType.test(contentType)) {
    const kind = contentType.split(";")[0]?.trim()
    return `answered ${kind === undefined || kind.length === 0 ? "a non-JSON body" : kind}, not an API error`
  }
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed
}

export interface OpenApiCall {
  readonly call: HttpCall
  readonly tool: string
  readonly server: string
  readonly input: Json
  readonly credential: Option.Option<ResolvedCredential>
  readonly timeoutMillis?: number
  readonly maxInlineBytes?: number
}

const defaultTimeoutMillis = 60_000

const previewBytes = 600

const utf8 = new TextDecoder()

export class OpenApiInvoker extends Context.Service<
  OpenApiInvoker,
  {
    readonly call: (
      call: OpenApiCall
    ) => Effect.Effect<Json, InvocationError | SpecError | StorageError>
  }
>()("@integrations/integrations/OpenApiInvoker") {
  static readonly layer: Layer.Layer<
    OpenApiInvoker,
    never,
    HttpClient.HttpClient | BlobStore
  > = Layer.effect(
    OpenApiInvoker,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const blobs = yield* BlobStore
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

        const request = HttpClientRequest.make(built.method)(prepared.url, {
          headers: { accept: "application/json, */*", ...prepared.headers }
        })

        const response = yield* client.execute(Option.match(built.body, {
          onNone: () => request,
          onSome: (body) =>
            HttpClientRequest.bodyText(request, body, request.headers["content-type"])
        })).pipe(
          Effect.mapError((cause) => new InvocationError({
            code: "transport_error",
            detail: `${built.method} ${built.url}: ${describeCause(cause)}`
          })),
          Effect.timeoutOrElse({
            duration: call.timeoutMillis ?? defaultTimeoutMillis,
            orElse: () => Effect.fail(new InvocationError({
              code: "timeout",
              detail: `${call.tool} did not answer in time: ${built.method} ${built.url}`
            }))
          })
        )

        const contentType = response.headers["content-type"] ?? ""

        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text.pipe(
            Effect.mapError((cause) => new InvocationError({
              code: "response_error",
              detail: describeCause(cause),
              status: response.status
            }))
          )
          return yield* new InvocationError({
            code: `http_${response.status}`,
            // `built.url` and not the prepared one: a credential can be placed
            // in the query string, and this text reaches the caller.
            detail: `${built.method} ${built.url}: ${errorDetail(contentType, body)}`,
            status: response.status
          })
        }

        const limit = call.maxInlineBytes ?? defaultMaxInlineBytes
        const textual = isTextualContentType(contentType)
        const declared = Number(response.headers["content-length"])

        // The common case — a small JSON answer that announced its size — never
        // touches the disk.
        if (textual && Number.isFinite(declared) && declared <= limit) {
          const buffer = yield* response.arrayBuffer.pipe(
            Effect.mapError((cause) => new InvocationError({
              code: "response_error",
              detail: describeCause(cause),
              status: response.status
            }))
          )
          return decodeBody(contentType, utf8.decode(buffer))
        }

        // Everything else is streamed to disk before anything decides what it
        // is. Bytes are the lossless superset: text can be recovered from them,
        // but a decode that has already happened cannot be undone.
        const filename = filenameFromDisposition(response.headers["content-disposition"])
        const stored = yield* blobs.write(
          { contentType, filename },
          response.stream.pipe(Stream.mapError((cause) =>
            new InvocationError({
              code: "response_error",
              detail: describeCause(cause),
              status: response.status
            })
          ))
        )

        if (textual && stored.bytes <= limit) {
          const bytes = yield* blobs.readAll(stored.id)
          yield* blobs.discard(stored.id)
          return decodeBody(contentType, utf8.decode(bytes))
        }

        const preview = textual
          ? utf8.decode(yield* blobs.readPrefix(stored.id, previewBytes))
          : undefined

        return {
          [blobHandleKey]: stored.id,
          bytes: stored.bytes,
          contentType,
          sha256: stored.sha256,
          note: textual
            ? oversizeNote(contentType, stored.bytes, limit)
            : binaryNote(contentType),
          ...whenPresent("filename", filename),
          ...whenPresent("preview", preview)
        }
      })
      }
    })
  )

  static readonly unavailableTestLayer: Layer.Layer<OpenApiInvoker> = Layer.succeed(
    OpenApiInvoker,
    { call: () => Effect.die("Unexpected OpenAPI invocation") }
  )
}
