import { Cause, Context, Effect, Layer, Option, Result } from "effect"
import { whenPresent } from "@mokronos/contracts"
import { randomUUID } from "node:crypto"
import { GatewayStoreError } from "@mokronos/gateway-core"
import { StorageError } from "@mokronos/integrations"

/** What happens to a failure nobody declared.
 *
 *  Every handler in this package used to carry its own copy of
 *
 *      const orDieStorage = (effect) =>
 *        effect.pipe(Effect.catchTag("GatewayStoreError", Effect.die))
 *
 *  — five copies over roughly ninety call sites. The policy those copies encode
 *  is right: a rejected driver call is the gateway's problem, not the caller's,
 *  and no handler can do anything useful with one. What they got wrong is that
 *  `Effect.die` throws the failure away. The operator saw a 500 with no body,
 *  the log line sat in a different stream, and nothing tied the two together.
 *
 *  This module keeps the policy and adds the missing half: the failure is
 *  recorded through {@link ErrorCapture}, which answers with a correlation id,
 *  and that id travels both into the log and out to the caller. "The gateway
 *  could not complete this request (trace 5f3a…)" is a bug report; the bare
 *  sentence was not. */

/** What the sink is told about a failure beyond the cause itself. `operation`
 *  is the store operation that rejected, which {@link GatewayStoreError}
 *  already carries; it is absent for a defect caught at the edge, where all
 *  that is known is that something threw. */
export interface CaptureContext {
  readonly operation?: string
}

/** Where a recorded failure goes.
 *
 *  Deliberately a service rather than a hard-wired logger: a local gateway
 *  wants the log, a hosted one wants Sentry, and a test wants an array it can
 *  assert against. `captureException` answers the correlation id the operator
 *  will search for, so the sink decides what an id means — a Sentry event id,
 *  a log correlation id, an index into a test array. */
export interface ErrorSink {
  readonly captureException: (
    cause: Cause.Cause<unknown>,
    context: CaptureContext
  ) => Effect.Effect<string>
}

/** Short enough to read down a phone line, long enough not to collide within a
 *  log retention window. */
const newTraceId = (): string => randomUUID().replaceAll("-", "").slice(0, 12)

/** Mints an id, logs the cause under it, and hands it back.
 *
 *  A gateway with no error backend still gets the whole benefit: the response
 *  names an id, and `grep` over the log finds the driver message, the SQL
 *  operation and the stack that produced it. */
const loggingCapture: ErrorSink = {
  captureException: (cause, context) => {
    const traceId = newTraceId()
    return Effect.as(
      Effect.logError("Unhandled gateway failure", cause).pipe(
        Effect.annotateLogs({ traceId, ...whenPresent("operation", context.operation) })
      ),
      traceId
    )
  }
}

export class ErrorCapture extends Context.Service<ErrorCapture, ErrorSink>()(
  "@mokronos/integrations/ErrorCapture"
) {
  /** The default, and what an unprovided context falls back to. */
  static readonly logging: Layer.Layer<ErrorCapture> = Layer.succeed(ErrorCapture, loggingCapture)

  /** Records nothing and answers an empty id. For a test that asserts on
   *  status codes and does not want the log noise. */
  static readonly noop: Layer.Layer<ErrorCapture> = Layer.succeed(ErrorCapture, {
    captureException: () => Effect.succeed("")
  })
}

/** Resolved optionally so capturing never enters anyone's `R` channel. A host
 *  that provides no sink still gets ids and a log line; providing one redirects
 *  them. */
const resolveCapture: Effect.Effect<ErrorSink> = Effect.map(
  Effect.serviceOption(ErrorCapture),
  Option.getOrElse(() => loggingCapture)
)

/** A failure that has already been through a sink.
 *
 *  Carried as the defect so the edge can render the id that was recorded rather
 *  than minting a second one for the same failure — two ids for one event is
 *  worse than none, because it makes the log look like two incidents. */
export class CapturedFailure {
  readonly _tag = "CapturedFailure"
  constructor(
    readonly traceId: string,
    readonly operation: string
  ) {}
}

/** The one storage-failure translator.
 *
 *  Wrap a handler body in this and a storage failure — the gateway's own
 *  `GatewayStoreError` or the integration host's `StorageError`, which are the
 *  same problem on either side of the seam — is recorded and turned into a
 *  {@link CapturedFailure} defect. It subtracts those from the error channel and
 *  adds nothing — the same shape the five `orDieStorage` copies had — so
 *  adopting it is a rename at every call site and no endpoint's declared errors
 *  change.
 *
 *  It stays a defect rather than becoming a typed `InternalError` because an
 *  endpoint that declares "this can 500" invites a caller to handle it, and
 *  there is nothing to handle: the request did not happen. The edge renders it;
 *  see `failureLayer` in `handler.ts`. */
export const capture = <A, E, R>(
  effect: Effect.Effect<A, E | GatewayStoreError | StorageError, R>
) =>
  effect.pipe(
    Effect.catchTag(["GatewayStoreError", "StorageError"], (error) =>
      Effect.flatMap(resolveCapture, (sink) => {
        // The tag is what `catchTag` matched on, so this narrows in every real
        // case; the fallback exists because a caller's `E` is unconstrained and
        // could in principle carry a different type under the same tag. A
        // failure recorded without its operation is still worth recording.
        // `GatewayStoreError` names the statement that rejected; the host's
        // `StorageError` carries a sentence instead, which is the same thing at
        // a coarser grain and is what the sink wants to group on.
        const operation = error instanceof GatewayStoreError
          ? error.operation
          : error instanceof StorageError
          ? error.message
          : "unknown"
        return Effect.flatMap(
          sink.captureException(Cause.fail(error), { operation }),
          (traceId) => Effect.die(new CapturedFailure(traceId, operation))
        )
      }))
  )

/** The correlation id for a cause about to be rendered as a 500.
 *
 *  A cause that already carries a {@link CapturedFailure} was recorded by
 *  {@link capture} and keeps its id. Anything else reached the edge without
 *  passing a sink — a genuine bug, a defect from a library — and is recorded
 *  here, which is what makes this the safety net rather than a second policy. */
export const traceIdFor = (cause: Cause.Cause<unknown>): Effect.Effect<string> => {
  const defect = Cause.findDefect(cause)
  if (Result.isSuccess(defect) && defect.success instanceof CapturedFailure) {
    return Effect.succeed(defect.success.traceId)
  }
  return Effect.flatMap(resolveCapture, (sink) => sink.captureException(cause, {}))
}
