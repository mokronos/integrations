import { randomBytes } from "node:crypto"
import { createServer as createHttpServer } from "node:http"
import type { Server as HttpServer } from "node:http"
import { createServer as createTcpServer } from "node:net"
import type { Server as TcpServer } from "node:net"
import { gzipSync } from "node:zlib"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
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

  it.live("names the host in the TLS handshake while connecting where the checked lookup points", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverNames: Array<string | undefined> = []
        const server = yield* listening(
          createTcpServer((socket) => {
            let hello = Buffer.alloc(0)
            socket.on("data", (chunk: Buffer) => {
              hello = Buffer.concat([hello, chunk])
              if (hello.length < 5 || hello.length < 5 + hello.readUInt16BE(3)) return
              serverNames.push(serverNameOf(hello))
              socket.destroy()
            })
          })
        )
        yield* Effect.flip(
          Effect.tryPromise(() =>
            nativeConnect(defaultUrlPolicy, toLoopback)(new URL(`https://service.test:${server.port}/`), {})
          )
        )
        expect(serverNames).toEqual(["service.test"])
      })
    )
  )

  it.live("sends the request under its own host name and decodes a compressed answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* listening(
          createHttpServer((request, response) => {
            const chunks: Array<Buffer> = []
            request.on("data", (chunk: Buffer) => chunks.push(chunk))
            request.on("end", () => {
              const echo = {
                method: request.method,
                host: request.headers.host,
                length: request.headers["content-length"],
                body: Buffer.concat(chunks).toString()
              }
              response.writeHead(201, { "content-type": "application/json", "content-encoding": "gzip" })
              response.end(gzipSync(JSON.stringify(echo)))
            })
          })
        )
        const response = yield* Effect.promise(() =>
          nativeConnect(defaultUrlPolicy, toLoopback)(new URL(`http://service.test:${server.port}/echo`), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"q":1}'
          })
        )
        const echo = yield* Effect.promise(() => response.text())
        expect({ status: response.status, echo: JSON.parse(echo) }).toEqual({
          status: 201,
          echo: { method: "POST", host: `service.test:${server.port}`, length: "7", body: '{"q":1}' }
        })
      })
    )
  )

  it.live("fails a compressed answer the connection cuts off instead of leaving it pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const whole = gzipSync(randomBytes(64 * 1024))
        const server = yield* listening(
          createHttpServer((_request, response) => {
            response.writeHead(200, { "content-encoding": "gzip", "content-length": String(whole.byteLength) })
            response.write(whole.subarray(0, 100), () => response.socket?.destroy())
          })
        )
        const outcome = yield* Effect.tryPromise(async () => {
          const response = await nativeConnect(defaultUrlPolicy, toLoopback)(
            new URL(`http://service.test:${server.port}/`),
            {}
          )
          return response.text()
        }).pipe(
          Effect.match({ onFailure: () => "failed", onSuccess: () => "succeeded" }),
          Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed("pending") })
        )
        expect(outcome).toBe("failed")
      })
    )
  )
})

/** Answers every name with loopback, where the tests' servers listen. */
const toLoopback: AddressLookup = (_hostname, _options, callback) =>
  callback(null, [{ address: "127.0.0.1", family: 4 }])

const decodeListening = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))

const listening = (server: TcpServer | HttpServer) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly port: number }>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.sync(() => decodeListening(server.address()))))
    }),
    () =>
      Effect.callback<void>((resume) => {
        if ("closeAllConnections" in server) server.closeAllConnections()
        server.close(() => resume(Effect.void))
      })
  )

/** The server_name a TLS ClientHello carries, read straight off the wire. */
const serverNameOf = (hello: Buffer): string | undefined => {
  // Record header (5), handshake header (4), client version (2), random (32).
  let at = 5 + 4 + 2 + 32
  at += 1 + hello.readUInt8(at)
  at += 2 + hello.readUInt16BE(at)
  at += 1 + hello.readUInt8(at)
  const end = at + 2 + hello.readUInt16BE(at)
  at += 2
  while (at + 4 <= end) {
    const type = hello.readUInt16BE(at)
    const length = hello.readUInt16BE(at + 2)
    // server_name: list length (2), name type (1), name length (2), name.
    if (type === 0) return hello.subarray(at + 9, at + 9 + hello.readUInt16BE(at + 7)).toString("ascii")
    at += 4 + length
  }
  return undefined
}
