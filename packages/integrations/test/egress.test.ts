import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { checkedFetch, DestinationRefused } from "../src/egress/egress.ts"
import type { Connect } from "../src/egress/egress.ts"
import { nativeConnect } from "../src/egress/native.ts"
import type { AddressLookup } from "../src/egress/native.ts"
import { AllowedOrigin, defaultUrlPolicy, parseDestination } from "../src/egress/url-policy.ts"

const reachable = (url: string, policy = defaultUrlPolicy) => parseDestination(url, policy) !== undefined

describe("the URL policy", () => {
  it("refuses private, link-local, carrier-grade NAT and internal destinations", () => {
    const refused = [
      "https://169.254.169.254/latest/meta-data",
      "https://10.1.2.3/",
      "https://100.64.0.1/",
      "https://[fd00::1]/",
      "https://[::ffff:10.0.0.1]/",
      "https://intranet/",
      "https://vault.internal/",
      "http://api.example.com/"
    ].filter((url) => reachable(url))
    expect(refused).toEqual([])
  })

  it("allows public HTTPS, loopback HTTP, and an exact origin the operator names", () => {
    const nas = { allowLoopbackHttp: false, allowedOrigins: [AllowedOrigin.make("http://nas.lan:8080")] }
    expect([
      reachable("https://api.example.com/v1"),
      reachable("http://127.0.0.1:4788/mcp"),
      reachable("http://nas.lan:8080/api", nas),
      reachable("http://nas.lan:8081/api", nas),
      reachable("http://127.0.0.1:4788/mcp", nas)
    ]).toEqual([true, true, true, false, false])
  })
})

const recordingConnect = (answers: ReadonlyArray<Response>) => {
  const seen: Array<{ readonly url: string; readonly headers: Headers }> = []
  let next = 0
  const connect: Connect = (url, init) => {
    seen.push({ url: url.href, headers: new Headers(init.headers) })
    const answer = answers[next] ?? new Response("done")
    next += 1
    return Promise.resolve(answer)
  }
  return { seen, connect }
}

const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })

describe("checked fetch", () => {
  it.effect("refuses a redirect into private address space", () =>
    Effect.gen(function* () {
      const { connect } = recordingConnect([redirect("https://169.254.169.254/latest")])
      const failure = yield* Effect.flip(
        Effect.tryPromise(() => checkedFetch(defaultUrlPolicy, connect)("https://api.example.com/start"))
      )
      expect(failure.cause).toBeInstanceOf(DestinationRefused)
    })
  )

  it.effect("drops credentials when a redirect leaves the origin", () =>
    Effect.gen(function* () {
      const { seen, connect } = recordingConnect([redirect("https://cdn.example.net/file")])
      yield* Effect.promise(() =>
        checkedFetch(defaultUrlPolicy, connect)("https://api.example.com/start", {
          headers: { authorization: "Bearer secret", "x-api-key": "secret", accept: "application/json" }
        })
      )
      expect([...(seen[1]?.headers.keys() ?? [])]).toEqual(["accept"])
    })
  )

  it.effect("hands back a redirect that would replay a request body", () =>
    Effect.gen(function* () {
      const { seen, connect } = recordingConnect([redirect("https://api.example.com/other", 307)])
      const response = yield* Effect.promise(() =>
        checkedFetch(defaultUrlPolicy, connect)("https://api.example.com/start", { method: "POST", body: "payload" })
      )
      expect({ status: response.status, requests: seen.length }).toEqual({ status: 307, requests: 1 })
    })
  )
})

describe("native connect", () => {
  it.effect("refuses a public name that resolves into private space", () =>
    Effect.gen(function* () {
      const rebinding: AddressLookup = (_hostname, _options, callback) =>
        callback(null, [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.7", family: 4 }
        ])
      const failure = yield* Effect.flip(
        Effect.tryPromise(() => nativeConnect(defaultUrlPolicy, rebinding)(new URL("https://rebind.example.com/"), {}))
      )
      expect(failure.cause).toBeInstanceOf(DestinationRefused)
    })
  )
})
