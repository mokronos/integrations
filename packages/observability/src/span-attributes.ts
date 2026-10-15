import { Tracer } from "effect"
import { whenPresent } from "@integragents/contracts"

const httpNamespaces = ["http.", "url.", "server.", "client.", "user_agent.", "network."]

/**
 * The only HTTP attributes a span keeps. Effect's HTTP tracers also record the
 * full URL, its query string, and every request and response header, any of
 * which can carry a credential.
 */
const exportedHttpAttributes: ReadonlySet<string> = new Set([
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "server.address",
  "server.port",
  "url.scheme",
  "url.path"
])

const isExportedAttribute = (key: string): boolean =>
  exportedHttpAttributes.has(key) || !httpNamespaces.some((namespace) => key.startsWith(namespace))

const exportedEntries = <A>(attributes: Record<string, A>): Record<string, A> =>
  Object.fromEntries(Object.entries(attributes).filter(([key]) => isExportedAttribute(key)))

/** Wraps a tracer so attributes outside the allowlist never reach its spans. */
export const allowlistedTracer = (delegate: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const span = delegate.span(options)
      return {
        _tag: "Span",
        name: span.name,
        spanId: span.spanId,
        traceId: span.traceId,
        parent: span.parent,
        annotations: span.annotations,
        sampled: span.sampled,
        kind: span.kind,
        get status() {
          return span.status
        },
        get attributes() {
          return span.attributes
        },
        get links() {
          return span.links
        },
        end(endTime, exit) {
          span.end(endTime, exit)
        },
        attribute(key, value) {
          if (isExportedAttribute(key)) span.attribute(key, value)
        },
        event(name, startTime, attributes) {
          span.event(name, startTime, attributes === undefined ? undefined : exportedEntries(attributes))
        },
        addLinks(links) {
          span.addLinks(links)
        }
      }
    },
    ...whenPresent("context", delegate.context)
  })
