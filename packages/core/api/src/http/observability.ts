import { Cause, Context, Effect, Layer, Option, Result } from "effect"
import { webCrypto } from "@integrations/contracts"
import { whenPresent } from "@integrations/contracts"
import { GatewayStoreError, OAuthSessionError, PasswordError } from "@integrations/gateway-core"
import { StorageError } from "@integrations/host"

export interface CaptureContext {
  readonly operation?: string
  readonly kind?: string
}

export interface ErrorSink {
  readonly captureException: (
    cause: Cause.Cause<unknown>,
    context: CaptureContext
  ) => Effect.Effect<string>
}

const newTraceId: Effect.Effect<string> = Effect.map(
  Effect.orDie(webCrypto.randomUUIDv4),
  (uuid) => uuid.replaceAll("-", "").slice(0, 12)
)

const loggingCapture: ErrorSink = {
  captureException: (cause, context) =>
    Effect.gen(function*() {
      const traceId = yield* newTraceId
      yield* Effect.logError("Unhandled gateway failure", cause).pipe(
        Effect.annotateLogs({
          traceId,
          ...whenPresent("operation", context.operation),
          ...whenPresent("kind", context.kind)
        })
      )
      return traceId
    })
}

export class ErrorCapture extends Context.Service<ErrorCapture, ErrorSink>()(
  "@integrations/host/ErrorCapture"
) {
  static readonly logging: Layer.Layer<ErrorCapture> = Layer.succeed(ErrorCapture, loggingCapture)

  static readonly noop: Layer.Layer<ErrorCapture> = Layer.succeed(ErrorCapture, {
    captureException: () => Effect.succeed("")
  })
}

const resolveCapture: Effect.Effect<ErrorSink> = Effect.map(
  Effect.serviceOption(ErrorCapture),
  Option.getOrElse(() => loggingCapture)
)

export class CapturedFailure {
  readonly _tag = "CapturedFailure"
  constructor(
    readonly traceId: string,
    readonly operation: string
  ) {}
}

export const capture = <A, E, R>(
  effect: Effect.Effect<A, E | GatewayStoreError | StorageError | PasswordError | OAuthSessionError, R>
) =>
  effect.pipe(
    Effect.catchTag(
      ["GatewayStoreError", "StorageError", "PasswordError", "OAuthSessionError"],
      (error) =>
        Effect.flatMap(resolveCapture, (sink) => {
        const operation = error instanceof GatewayStoreError
          || error instanceof PasswordError
          || error instanceof OAuthSessionError
          ? error.operation
          : error instanceof StorageError
          ? error.message
          : "unknown"
        const kind = error instanceof GatewayStoreError ? error.kind : undefined
        return Effect.flatMap(
          sink.captureException(Cause.fail(error), { operation, ...whenPresent("kind", kind) }),
          (traceId) => Effect.die(new CapturedFailure(traceId, operation))
        )
      })
    )
  )

export const traceIdFor = (cause: Cause.Cause<unknown>): Effect.Effect<string> => {
  const defect = Cause.findDefect(cause)
  if (Result.isSuccess(defect) && defect.success instanceof CapturedFailure) {
    return Effect.succeed(defect.success.traceId)
  }
  return Effect.flatMap(resolveCapture, (sink) => sink.captureException(cause, {}))
}
