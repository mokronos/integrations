import { Effect, Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi
} from "effect/unstable/httpapi"

const EchoBody = Schema.Struct({ message: Schema.String })
const EchoResult = Schema.Struct({
  id: Schema.String,
  search: Schema.String,
  trace: Schema.String,
  message: Schema.String
})

const ReferenceGroup = HttpApiGroup.make("reference").add(
  HttpApiEndpoint.post("echo", "/items/:id", {
    params: { id: Schema.String },
    query: { search: Schema.String },
    headers: { "x-trace": Schema.String },
    payload: EchoBody,
    success: EchoResult
  })
)

export const ReferenceApi = HttpApi.make("ReferenceApi").add(ReferenceGroup)
export const referenceOpenApiDocument = JSON.stringify(OpenApi.fromApi(ReferenceApi))

export interface ReferenceOpenApiServer {
  readonly baseUrl: string
  readonly stop: () => void
}

export const startReferenceOpenApiServer = (): ReferenceOpenApiServer => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const match = /^\/items\/([^/]+)$/.exec(url.pathname)
      if (request.method !== "POST" || match === null) {
        return new Response("not found", { status: 404 })
      }

      return Effect.runPromise(Effect.gen(function*() {
        const body = yield* Schema.decodeUnknownEffect(EchoBody)(yield* Effect.promise(
          () => request.json()
        ))
        const result = yield* Schema.encodeEffect(EchoResult)({
          id: decodeURIComponent(match[1] ?? ""),
          search: url.searchParams.get("search") ?? "",
          trace: request.headers.get("x-trace") ?? "",
          message: body.message
        })
        return Response.json(result)
      }).pipe(Effect.catch(() => Effect.succeed(Response.json(
        { error: "invalid request" },
        { status: 400 }
      )))))
    }
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true)
  }
}

