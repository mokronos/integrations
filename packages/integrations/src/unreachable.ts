import { Option, Predicate } from "effect"
import { DestinationRefused } from "./egress/egress.ts"

const maxDepth = 6

const errnoCode = /^[A-Za-z][A-Za-z0-9_]{1,63}$/

/**
 * The errno-style code (ECONNREFUSED, ENOTFOUND, UND_ERR_SOCKET, ...) on a
 * failed connection's cause chain. Safe for logs and spans, where the failure
 * itself is not: it carries the whole request, resolved credentials included.
 */
export const transportCode = (cause: unknown, depth = 0): Option.Option<string> => {
  if (depth > maxDepth) return Option.none()
  if (Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) && errnoCode.test(cause.code)) {
    return Option.some(cause.code)
  }
  return Predicate.hasProperty(cause, "cause") ? transportCode(cause.cause, depth + 1) : Option.none()
}

/** The egress refusal on a failed request's cause chain, whose message names the host only. */
export const refusedDestination = (cause: unknown, depth = 0): Option.Option<DestinationRefused> => {
  if (cause instanceof DestinationRefused) return Option.some(cause)
  if (depth > maxDepth) return Option.none()
  return Predicate.hasProperty(cause, "cause") ? refusedDestination(cause.cause, depth + 1) : Option.none()
}

export const hostOf = (url: string): string => URL.parse(url)?.host ?? "the upstream host"
