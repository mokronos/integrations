import { Effect, Predicate, Schema } from "effect"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
  gatewayProtocolVersion,
  makeGatewayClient,
  readGatewayMetadata
} from "@mokronos/integrations-client"

const HostedUrl = Schema.String.pipe(Schema.refine((value): value is string => {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}))
const ClientCreated = Schema.Struct({ id: Schema.String })
const KeyCreated = Schema.Struct({ secret: Schema.String })
const HostedAcceptanceResult = Schema.Struct({
  gatewayVersion: Schema.String,
  protocolVersion: Schema.Number,
  delegatedClient: Schema.Boolean,
  administrationRejected: Schema.Boolean,
  oauthProvider: Schema.String,
  oauthCallbackUrl: Schema.String
})
const encodeResult = Schema.encodeSync(Schema.fromJsonString(HostedAcceptanceResult))
const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const gatewayUrl = Schema.decodeUnknownSync(HostedUrl)(
  process.env["INTEGRATIONS_STAGING_URL"]
).replace(/\/+$/, "")
const password = `staging-${crypto.randomUUID()}-${crypto.randomUUID()}`
const email = `acceptance-${crypto.randomUUID()}@example.com`

const errorMessage = (body: Schema.Json, fallback: string): string =>
  Predicate.isObject(body) && Predicate.isString(body["error"])
    ? body["error"]
    : fallback

const post = Effect.fn("acceptance.post")(function*(
  route: string,
  options: { readonly body?: Schema.Json; readonly headers?: Record<string, string> } = {}
) {
  const request = HttpClientRequest.post(`${gatewayUrl}${route}`, {
    headers: options.headers ?? {}
  })
  const response = yield* HttpClient.execute(
    options.body === undefined
      ? request
      : HttpClientRequest.setBody(request, HttpBody.jsonUnsafe(options.body))
  )
  const text = yield* response.text
  const payload = text.trim().length === 0
    ? {}
    : yield* decodeJsonText(text)
  return { response, payload }
})

const operatorRequest = (cookie: string) =>
  Effect.fn("acceptance.operatorRequest")(function*(route: string, body: Schema.Json) {
    const { response, payload } = yield* post(route, {
      body,
      headers: { cookie, origin: gatewayUrl }
    })
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.die(
        new Error(errorMessage(payload, `${route} failed with ${response.status}`))
      )
    }
    return payload
  })

const program = Effect.gen(function*() {
  const signup = yield* post("/v1/auth/signup", {
    body: { email, password, tenantName: "Hosted acceptance" }
  })
  if (signup.response.status < 200 || signup.response.status >= 300) {
    return yield* Effect.die(
      new Error(errorMessage(signup.payload, `Signup failed with ${signup.response.status}`))
    )
  }
  const setCookie = signup.response.headers["set-cookie"] ?? ""
  if (!setCookie.includes("Secure")) {
    return yield* Effect.die(new Error("Hosted session cookie is not Secure"))
  }
  const cookie = setCookie.split(";", 1)[0] ?? ""
  const request = operatorRequest(cookie)

  return yield* Effect.gen(function*() {
    const metadata = yield* readGatewayMetadata(gatewayUrl)
    if (metadata.protocolVersion !== gatewayProtocolVersion) {
      return yield* Effect.die(
        new Error("The staging gateway protocol changed during acceptance")
      )
    }

    const client = Schema.decodeUnknownSync(ClientCreated)(
      yield* request("/v1/clients", {
        name: `acceptance-${crypto.randomUUID()}`,
        capabilities: ["provision_connections"]
      })
    )
    const key = Schema.decodeUnknownSync(KeyCreated)(
      yield* request(`/v1/clients/${encodeURIComponent(client.id)}/keys`, {})
    )
    const delegated = yield* makeGatewayClient({ url: gatewayUrl, apiKey: key.secret })
    if ((yield* delegated.connections()).connections.length !== 0) {
      return yield* Effect.die(new Error("A fresh hosted tenant unexpectedly has connections"))
    }

    const administrative = yield* HttpClient.get(`${gatewayUrl}/v1/clients`, {
      headers: { authorization: `Bearer ${key.secret}` }
    })
    if (administrative.status !== 403) {
      return yield* Effect.die(
        new Error(`Delegated key reached administration with HTTP ${administrative.status}`)
      )
    }

    const discovery = yield* delegated.discover({ url: "https://mcp.linear.app/mcp" })
    const oauth = yield* delegated.startOAuth({ integration: discovery.integration.slug })
    if (oauth.state.status !== "pending") {
      return yield* Effect.die(
        new Error(`Linear OAuth did not return a pending authorization: ${oauth.state.status}`)
      )
    }
    const oauthProvider = new URL(oauth.state.authorizationUrl).hostname
    if (oauthProvider !== "linear.app" && !oauthProvider.endsWith(".linear.app")) {
      return yield* Effect.die(new Error(`Unexpected Linear OAuth provider ${oauthProvider}`))
    }

    return {
      gatewayVersion: metadata.gatewayVersion,
      protocolVersion: metadata.protocolVersion,
      delegatedClient: true,
      administrationRejected: true,
      oauthProvider,
      oauthCallbackUrl: `${gatewayUrl}/v1/oauth/callback`
    } satisfies typeof HostedAcceptanceResult.Type
  }).pipe(
    Effect.ensuring(Effect.ignore(request("/v1/auth/account/delete", { password })))
  )
})

const result = await Effect.runPromise(
  program.pipe(Effect.orDie, Effect.provide(FetchHttpClient.layer))
)
process.stdout.write(`${encodeResult(result)}\n`)
