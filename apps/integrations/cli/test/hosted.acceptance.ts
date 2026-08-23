import { Predicate, Schema } from "effect"
import {
  createGatewayClient,
  GatewayMetadata,
  gatewayProtocolVersion,
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
const decodeJson = Schema.decodeUnknownPromise(Schema.fromJsonString(Schema.Json))

const gatewayUrl = Schema.decodeUnknownSync(HostedUrl)(
  process.env["INTEGRATIONS_STAGING_URL"]
).replace(/\/+$/, "")
const password = `staging-${crypto.randomUUID()}-${crypto.randomUUID()}`
const email = `acceptance-${crypto.randomUUID()}@example.com`

const errorMessage = (body: Schema.Json, fallback: string): string =>
  Predicate.isObject(body) && Predicate.isString(body["error"])
    ? body["error"]
    : fallback

const responseBody = async (response: Response): Promise<Schema.Json> => {
  const text = await response.text()
  return text.trim().length === 0 ? {} : await decodeJson(text)
}

const signup = await fetch(`${gatewayUrl}/v1/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password, tenantName: "Hosted acceptance" })
})
const signupBody = await responseBody(signup)
if (!signup.ok) throw new Error(errorMessage(signupBody, `Signup failed with ${signup.status}`))
const setCookie = signup.headers.get("set-cookie") ?? ""
if (!setCookie.includes("Secure")) throw new Error("Hosted session cookie is not Secure")
const cookie = setCookie.split(";", 1)[0] ?? ""

const operatorRequest = async (
  route: string,
  body: Schema.Json
): Promise<Schema.Json> => {
  const response = await fetch(`${gatewayUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: gatewayUrl
    },
    body: JSON.stringify(body)
  })
  const payload = await responseBody(response)
  if (!response.ok) {
    throw new Error(errorMessage(payload, `${route} failed with ${response.status}`))
  }
  return payload
}

let metadata: GatewayMetadata | undefined
let oauthProvider = ""
try {
  metadata = await readGatewayMetadata(gatewayUrl)
  if (metadata.protocolVersion !== gatewayProtocolVersion) {
    throw new Error("The staging gateway protocol changed during acceptance")
  }

  const client = Schema.decodeUnknownSync(ClientCreated)(
    await operatorRequest("/v1/clients", {
      name: `acceptance-${crypto.randomUUID()}`,
      capabilities: ["provision_connections"]
    })
  )
  const key = Schema.decodeUnknownSync(KeyCreated)(
    await operatorRequest(`/v1/clients/${encodeURIComponent(client.id)}/keys`, {})
  )
  const delegated = createGatewayClient({ url: gatewayUrl, apiKey: key.secret })
  if ((await delegated.connections()).connections.length !== 0) {
    throw new Error("A fresh hosted tenant unexpectedly has connections")
  }

  const administrative = await fetch(`${gatewayUrl}/v1/clients`, {
    headers: { authorization: `Bearer ${key.secret}` }
  })
  if (administrative.status !== 403) {
    throw new Error(`Delegated key reached administration with HTTP ${administrative.status}`)
  }

  const discovery = await delegated.discover({ url: "https://mcp.linear.app/mcp" })
  const oauth = await delegated.startOAuth({ integration: discovery.integration.slug })
  if (oauth.state.status !== "pending") {
    throw new Error(`Linear OAuth did not return a pending authorization: ${oauth.state.status}`)
  }
  oauthProvider = new URL(oauth.state.authorizationUrl).hostname
  if (oauthProvider !== "linear.app" && !oauthProvider.endsWith(".linear.app")) {
    throw new Error(`Unexpected Linear OAuth provider ${oauthProvider}`)
  }

  const result: typeof HostedAcceptanceResult.Type = {
    gatewayVersion: metadata.gatewayVersion,
    protocolVersion: metadata.protocolVersion,
    delegatedClient: true,
    administrationRejected: true,
    oauthProvider,
    oauthCallbackUrl: `${gatewayUrl}/v1/oauth/callback`
  }
  process.stdout.write(`${encodeResult(result)}\n`)
} finally {
  await operatorRequest("/v1/auth/account/delete", { password }).catch(() => undefined)
}
