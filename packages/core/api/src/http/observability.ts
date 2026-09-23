import { Cause, Context, Effect, Layer, Option, Result } from "effect"
import { whenPresent } from "@integragents/contracts"
import { GatewayStoreError, OAuthSessionError, PasswordError } from "@integragents/gateway-core"
import { StorageError } from "@integragents/host"

export interface CaptureContext {
  readonly operation?: string
  readonly kind?: string
}

export interface ErrorSink {
  readonly captureException: (
    cause: Cause.Cause<unknown>,
    context: CaptureContext
  ) => Effect.Effect<void>
}

/** The trace this request runs in, which is what an operator looks the failure up by. */
export const currentTraceId: Effect.Effect<string> = Effect.currentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "untraced")
)

const loggingCapture: ErrorSink = {
  captureException: (cause, context) =>
    Effect.logError("Unhandled gateway failure", cause).pipe(
      Effect.annotateLogs({
        ...whenPresent("operation", context.operation),
        ...whenPresent("kind", context.kind)
      })
    )
}

export class ErrorCapture extends Context.Service<ErrorCapture, ErrorSink>()(
  "@integragents/gateway-api/ErrorCapture"
) {
  static readonly logging: Layer.Layer<ErrorCapture> = Layer.succeed(ErrorCapture, loggingCapture)

  static readonly noop: Layer.Layer<ErrorCapture> = Layer.succeed(ErrorCapture, {
    captureException: () => Effect.void
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
        return sink.captureException(Cause.fail(error), { operation, ...whenPresent("kind", kind) }).pipe(
          Effect.andThen(currentTraceId),
          Effect.flatMap((traceId) => Effect.die(new CapturedFailure(traceId, operation)))
        )
      })
    )
  )

export const traceIdFor = (cause: Cause.Cause<unknown>): Effect.Effect<string> => {
  const defect = Cause.findDefect(cause)
  if (Result.isSuccess(defect) && defect.success instanceof CapturedFailure) {
    return Effect.succeed(defect.success.traceId)
  }
  return Effect.flatMap(resolveCapture, (sink) => sink.captureException(cause, {})).pipe(
    Effect.andThen(currentTraceId)
  )
}
