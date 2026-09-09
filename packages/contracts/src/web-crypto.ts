import { Crypto, Effect, Layer, PlatformError } from "effect"

/**
 * The Crypto service over the platform's WebCrypto, which Bun, Node, and the
 * Cloudflare runtime all expose as `globalThis.crypto`. One layer covers every
 * place the gateway runs, so minting an identifier does not depend on which
 * one it is running in.
 */
export const webCrypto: Crypto.Crypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      // A view over a SharedArrayBuffer is not a BufferSource; copying the
      // bytes keeps the call well-typed whatever the caller handed us.
      try: () => globalThis.crypto.subtle.digest(algorithm, Uint8Array.from(data)),
      catch: (cause) =>
        PlatformError.badArgument({
          module: "Crypto",
          method: "digest",
          description: `${algorithm} is not available on this platform`,
          cause
        })
    }).pipe(Effect.map((digested) => new Uint8Array(digested)))
})

export const webCryptoLayer: Layer.Layer<Crypto.Crypto> = Layer.succeed(Crypto.Crypto, webCrypto)
