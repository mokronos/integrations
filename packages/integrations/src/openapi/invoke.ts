import { buildRequest } from "./request.ts"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { describeCause, InvocationError, SpecError, StorageError } from "../errors.ts"
import { hostOf, refusedDestination, transportCode } from "../unreachable.ts"
import type { HttpCall } from "../tool.ts"
import { missingArguments, splitArguments } from "./arguments.ts"
import { AuthPlacement } from "@integragents/contracts"
import { parseJsonString, whenPresent, type Json } from "@integragents/contracts"
import {
  binaryNote,
  blobHandleKey,
  defaultMaxInlineBytes,
  filenameFromDisposition,
  isTextualContentType,
  oversizeNote
} from "@integragents/contracts"
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
      const placements = resolved.placements.length === 0 ? [bearerPlacement] : resolved.placements
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

const decodeBody = (contentType: string, body: string): Json => {
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

const errorBodyLimit = 600
const upstreamErrorLimit = 8_000

const bounded = (text: string): string => (text.length > errorBodyLimit ? `${text.slice(0, errorBodyLimit)}…` : text)

const errorDetail = (contentType: string, body: string): string => {
  const trimmed = body.trim()
  if (trimmed.length === 0) return "no response body"
  // An API answering HTML is an API that was never reached, and its error page
  // is worth less to the caller than knowing that is what happened.
  if (!jsonContentType.test(contentType) && !/^text\/plain\b/i.test(contentType)) {
    const kind = contentType.split(";")[0]?.trim()
    return `answered ${kind === undefined || kind.length === 0 ? "a non-JSON body" : kind}, not an API error`
  }
  return bounded(trimmed)
}

/** Where APIs put the sentence that explains an error, in the order they are tried. */
const explanations: ReadonlyArray<(body: Json) => Option.Option<string>> = [
  (body) =>
    Option.map(Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(body), (said) => said.message),
  (body) =>
    Option.map(
      Schema.decodeUnknownOption(Schema.Struct({ error_description: Schema.String }))(body),
      (said) => said.error_description
    ),
  (body) =>
    Option.map(Schema.decodeUnknownOption(Schema.Struct({ detail: Schema.String }))(body), (said) => said.detail),
  (body) => Option.map(Schema.decodeUnknownOption(Schema.Struct({ title: Schema.String }))(body), (said) => said.title),
  (body) => Option.map(Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }))(body), (said) => said.error),
  (body) =>
    Option.map(
      Schema.decodeUnknownOption(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }))(body),
      (said) => said.error.message
    )
]

const explanationOf = (body: Json): Option.Option<string> =>
  Option.firstSomeOf(explanations.map((explain) => explain(body)))

/**
 * The upstream's own explanation leads, when its body names one; a JSON body
 * small enough to read whole goes along, so the caller can see every field it rejected.
 */
const upstreamFailure = (request: string, status: number, contentType: string, body: string) => {
  const parsed = jsonContentType.test(contentType) ? parseJsonString(body.trim()) : Option.none()
  const explained = Option.flatMap(parsed, explanationOf)
  return new InvocationError({
    code: "upstream_status",
    status,
    detail: `${request}: HTTP ${status}: ${Option.match(explained, {
      onNone: () => errorDetail(contentType, body),
      onSome: bounded
    })}`,
    ...whenPresent(
      "upstreamError",
      Option.getOrUndefined(Option.filter(parsed, () => body.length <= upstreamErrorLimit))
    )
  })
}

export interface OpenApiCall {
  readonly integration: string
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

/**
 * The gateway sends the request, not the user's browser, so the message names
 * the integration and host to check. The errno-style code goes to the span and
 * logs; the failure itself never leaves, since it carries the whole request.
 */
const unreachable = (call: OpenApiCall, url: string, cause: unknown, status?: number) => {
  const host = hostOf(url)
  const code = transportCode(cause)
  const detail = Option.match(refusedDestination(cause), {
    onNone: () => `${call.integration} could not reach ${host}. Check its base URL and that the service is online.`,
    onSome: (refused) => `${call.integration}: ${refused.message}`
  })
  const annotations = {
    integration: call.integration,
    "server.address": host,
    ...whenPresent("error.code", Option.getOrUndefined(code))
  }
  return Effect.annotateCurrentSpan(annotations).pipe(
    Effect.andThen(Effect.logWarning("OpenAPI upstream unreachable").pipe(Effect.annotateLogs(annotations))),
    Effect.andThen(Effect.fail(new InvocationError({ code: "network", detail, ...whenPresent("status", status) })))
  )
}

export class OpenApiInvoker extends Context.Service<
  OpenApiInvoker,
  {
    readonly call: (call: OpenApiCall) => Effect.Effect<Json, InvocationError | SpecError | StorageError>
  }
>()("@integragents/integrations/OpenApiInvoker") {
  static readonly layer: Layer.Layer<OpenApiInvoker, never, HttpClient.HttpClient | BlobStore> = Layer.effect(
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
              detail: `${call.tool} does not accept: ${split.unknown.join(", ")}`,
              arguments: split.unknown
            })
          }
          const missing = missingArguments(call.call, split.parameters)
          if (missing.length > 0) {
            return yield* new InvocationError({
              code: "missing_argument",
              detail: `${call.tool} requires: ${missing.join(", ")}`,
              arguments: missing
            })
          }

          const built = yield* Effect.try({
            try: () =>
              buildRequest({
                call: call.call,
                server: call.server,
                parameters: split.parameters,
                requestBody: split.requestBody
              }),
            catch: (cause) =>
              new SpecError({
                source: call.tool,
                detail: `Could not build the request: ${describeCause(cause)}`,
                cause
              })
          })

          const prepared = applyCredential({ url: built.url, headers: { ...built.headers } }, call.credential)

          const request = HttpClientRequest.make(built.method)(prepared.url, {
            headers: { accept: "application/json, */*", ...prepared.headers }
          })

          const withBody = Option.isNone(built.body)
            ? Effect.succeed(request)
            : built.body.value.kind === "text"
              ? Effect.succeed(
                  HttpClientRequest.bodyText(request, built.body.value.value, request.headers["content-type"])
                )
              : Effect.map(blobs.open(built.body.value.id), (opened) =>
                  HttpClientRequest.bodyStream(request, opened.content, {
                    contentType: opened.metadata.contentType,
                    contentLength: opened.metadata.bytes
                  })
                )

          const response = yield* client.execute(yield* withBody).pipe(
            Effect.catch((cause) => unreachable(call, built.url, cause)),
            Effect.timeoutOrElse({
              duration: call.timeoutMillis ?? defaultTimeoutMillis,
              orElse: () =>
                Effect.fail(
                  new InvocationError({
                    code: "timeout",
                    detail: `${call.tool} did not answer in time from ${hostOf(built.url)}`
                  })
                )
            })
          )

          const contentType = response.headers["content-type"] ?? ""

          if (response.status < 200 || response.status >= 300) {
            const body = yield* response.text.pipe(
              Effect.catch((cause) => unreachable(call, built.url, cause, response.status))
            )
            // `built.url` and not the prepared one: a credential can be placed
            // in the query string, and this text reaches the caller.
            return yield* upstreamFailure(`${built.method} ${built.url}`, response.status, contentType, body)
          }

          const limit = call.maxInlineBytes ?? defaultMaxInlineBytes
          const textual = isTextualContentType(contentType)
          const declared = Number(response.headers["content-length"])

          // The common case — a small JSON answer that announced its size — never
          // touches the disk.
          if (textual && Number.isFinite(declared) && declared <= limit) {
            const buffer = yield* response.arrayBuffer.pipe(
              Effect.catch((cause) => unreachable(call, built.url, cause, response.status))
            )
            return decodeBody(contentType, utf8.decode(buffer))
          }

          // Everything else is streamed to disk before anything decides what it
          // is. Bytes are the lossless superset: text can be recovered from them,
          // but a decode that has already happened cannot be undone.
          const filename = filenameFromDisposition(response.headers["content-disposition"])
          const stored = yield* blobs.write(
            { contentType, filename },
            response.stream.pipe(
              Stream.catch((cause) => Stream.fromEffect(unreachable(call, built.url, cause, response.status)))
            )
          )

          if (textual && stored.bytes <= limit) {
            const bytes = yield* blobs.readAll(stored.id)
            yield* blobs.discard(stored.id)
            return decodeBody(contentType, utf8.decode(bytes))
          }

          const preview = textual ? utf8.decode(yield* blobs.readPrefix(stored.id, previewBytes)) : undefined

          return {
            [blobHandleKey]: stored.id,
            bytes: stored.bytes,
            contentType,
            sha256: stored.sha256,
            note: textual ? oversizeNote(contentType, stored.bytes, limit) : binaryNote(contentType),
            ...whenPresent("filename", filename),
            ...whenPresent("preview", preview)
          }
        })
      }
    })
  )

  static readonly unavailableTestLayer: Layer.Layer<OpenApiInvoker> = Layer.succeed(OpenApiInvoker, {
    call: () => Effect.die("Unexpected OpenAPI invocation")
  })
}
