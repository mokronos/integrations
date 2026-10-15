import { Config, Schema, SchemaTransformation } from "effect"
import ipaddr from "ipaddr.js"

/** Reserved localhost names and loopback literals, classified without DNS. */
export const isLoopbackHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.(?:\d{1,2}|1\d\d|2[0-4]\d|25[0-5])){3}$/.test(host)
  )
}

/** An exact HTTP(S) origin, port included: no path, credentials, wildcard, query or fragment. */
export const AllowedOrigin = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const url = URL.parse(value)
      return (
        url !== null &&
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.hostname.includes("*") &&
        url.origin === value
      )
    },
    { message: "Expected an exact http(s) origin without a trailing slash" }
  )
).pipe(Schema.brand("AllowedOrigin"))
export type AllowedOrigin = typeof AllowedOrigin.Type

/**
 * Where the gateway may send requests on a user's behalf. HTTPS to public
 * hosts always; plain HTTP to loopback when allowed; anything else private
 * only through an exact origin the operator named.
 */
export const UrlPolicy = Schema.Struct({
  allowLoopbackHttp: Schema.Boolean,
  allowedOrigins: Schema.Array(AllowedOrigin)
})
export type UrlPolicy = typeof UrlPolicy.Type

export const defaultUrlPolicy: UrlPolicy = { allowLoopbackHttp: true, allowedOrigins: [] }

/** For protocols that require HTTPS even where the deployment allows other HTTP endpoints. */
export const httpsOnlyUrlPolicy: UrlPolicy = { allowLoopbackHttp: false, allowedOrigins: [] }

const AllowedOriginList = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(AllowedOrigin),
    SchemaTransformation.transform({
      decode: (value: string): ReadonlyArray<string> =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      encode: (origins: ReadonlyArray<string>) => origins.join(",")
    })
  )
)

/** `INTEGRATIONS_URL_ALLOW_LOOPBACK_HTTP` and a comma-separated `INTEGRATIONS_URL_ALLOWED_ORIGINS`. */
export const urlPolicyConfig: Config.Config<UrlPolicy> = Config.all({
  allowLoopbackHttp: Config.Boolean("INTEGRATIONS_URL_ALLOW_LOOPBACK_HTTP").pipe(
    Config.withDefault(defaultUrlPolicy.allowLoopbackHttp)
  ),
  allowedOrigins: Config.schema(AllowedOriginList, "INTEGRATIONS_URL_ALLOWED_ORIGINS").pipe(
    Config.withDefault(defaultUrlPolicy.allowedOrigins)
  )
})

const unwrap = (address: ipaddr.IPv4 | ipaddr.IPv6) =>
  "isIPv4MappedAddress" in address && address.isIPv4MappedAddress() ? address.toIPv4Address() : address

/**
 * Globally routable unicast only. Loopback, private, link-local, unique-local,
 * carrier-grade NAT, multicast, reserved and unspecified space are not public.
 */
export const isPublicAddress = (value: string): boolean =>
  ipaddr.isValid(value) && unwrap(ipaddr.parse(value)).range() === "unicast"

export const isLoopbackAddress = (value: string): boolean =>
  ipaddr.isValid(value) && unwrap(ipaddr.parse(value)).range() === "loopback"

const internalSuffixes = [".internal", ".local", ".localdomain", ".lan", ".home.arpa"]

const addressLiteral = (host: string) =>
  host.startsWith("[") && host.endsWith("]") ? (host.slice(1, -1).split("%")[0] ?? "") : host

/**
 * A syntactic reject for private literals, single-label names and reserved
 * internal suffixes. A name only becomes an address after DNS, so the native
 * egress client re-checks what it resolves to before connecting.
 */
export const isPrivateHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (host === "") return true
  const literal = addressLiteral(host)
  if (ipaddr.isValid(literal)) return !isPublicAddress(literal)
  if (host.startsWith("[")) return true
  if (isLoopbackHostname(host)) return true
  if (!host.includes(".")) return true
  return internalSuffixes.some((suffix) => host.endsWith(suffix))
}

const explicitlyAllowed = (url: URL, policy: UrlPolicy) => policy.allowedOrigins.some((origin) => origin === url.origin)

/** An absolute http(s) URL the transport rules accept; no userinfo or fragment. */
export const parseEndpoint = (value: string, policy: UrlPolicy): URL | undefined => {
  const url = URL.parse(value)
  if (url === null || url.username !== "" || url.password !== "" || url.href.includes("#")) return undefined
  if (url.protocol === "https:") return url
  if (url.protocol !== "http:") return undefined
  return (policy.allowLoopbackHttp && isLoopbackHostname(url.hostname)) || explicitlyAllowed(url, policy)
    ? url
    : undefined
}

/** A URL the gateway itself may fetch: `parseEndpoint` plus no private destination unless allowed. */
export const parseDestination = (value: string, policy: UrlPolicy): URL | undefined => {
  const url = parseEndpoint(value, policy)
  if (url === undefined) return undefined
  if (!isPrivateHostname(url.hostname)) return url
  if (policy.allowLoopbackHttp && isLoopbackHostname(url.hostname)) return url
  return explicitlyAllowed(url, policy) ? url : undefined
}

/** The hostname an operator exception names, which a connection-time check sees without the origin. */
export const exemptHostname = (hostname: string, policy: UrlPolicy): boolean =>
  policy.allowedOrigins.some((origin) => URL.parse(origin)?.hostname === hostname)

/** Whether a resolved address may be connected to under `policy`. */
export const permittedAddress = (address: string, policy: UrlPolicy): boolean =>
  isPublicAddress(address) || (policy.allowLoopbackHttp && isLoopbackAddress(address))
