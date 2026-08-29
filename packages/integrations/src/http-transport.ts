import { Context, Layer } from "effect"

export class HttpTransport extends Context.Service<
  HttpTransport,
  {
    readonly fetch: (url: string, options: RequestInit) => Promise<Response>
  }
>()("@mokronos/integrations/HttpTransport") {
  static readonly layer: Layer.Layer<HttpTransport> = Layer.succeed(HttpTransport, {
    fetch: globalThis.fetch
  })

  static readonly testLayer = (
    fetch: (url: string, options: RequestInit) => Promise<Response>
  ): Layer.Layer<HttpTransport> => Layer.succeed(HttpTransport, { fetch })

  static readonly unavailableTestLayer: Layer.Layer<HttpTransport> = Layer.succeed(HttpTransport, {
    fetch: async () => {
      throw new Error("Unexpected HTTP transport call")
    }
  })
}
