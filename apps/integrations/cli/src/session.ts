import { chmod, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { Predicate, Schema } from "effect"
import {
  createGatewayClient,
  integrationsHome,
  readGatewayConfig,
  resolveClientConnection
} from "@mokronos/integrations-client"
import type { GatewayClient } from "@mokronos/integrations-client"
import { cliError } from "./connection.ts"
import { whenPresentMap } from "./optional.ts"

const OperatorSession = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  email: Schema.String
})
export type OperatorSession = typeof OperatorSession.Type

const OperatorSessionJson = Schema.fromJsonString(OperatorSession)
const decodeOperatorSession = Schema.decodeUnknownSync(OperatorSessionJson)
const encodeOperatorSession = Schema.encodeSync(OperatorSessionJson)

export const operatorSessionPath = (): string =>
  path.join(integrationsHome(), "operator-session.json")

const configuredUrl = (): string | undefined => {
  const value = process.env["INTEGRATIONS_URL"]?.trim()
  return value === undefined || value.length === 0
    ? undefined
    : value.replace(/\/+$/, "")
}

export const resolveGatewayUrl = async (): Promise<string> => {
  const explicit = configuredUrl()
  if (explicit !== undefined) return explicit
  const config = await readGatewayConfig(integrationsHome())
  if (config !== undefined) return config.url.replace(/\/+$/, "")
  throw cliError(
    "No gateway found. Set INTEGRATIONS_URL, or start the local gateway with `ii serve`."
  )
}

export const readOperatorSession = async (): Promise<OperatorSession | undefined> => {
  const file = Bun.file(operatorSessionPath())
  if (!await file.exists()) return undefined
  try {
    return decodeOperatorSession(await file.text())
  } catch (cause) {
    throw cliError(
      `The saved ii session is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
}

export const writeOperatorSession = async (session: OperatorSession): Promise<void> => {
  const destination = operatorSessionPath()
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  await Bun.write(destination, `${encodeOperatorSession(session)}\n`)
  await chmod(destination, 0o600)
}

export const clearOperatorSession = async (): Promise<void> => {
  await rm(operatorSessionPath(), { force: true })
}

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

const messageFrom = (payload: typeof Schema.Json.Type, fallback: string): string => {
  if (Predicate.isObject(payload) && "error" in payload) {
    const error = payload["error"]
    if (Predicate.isString(error) && error.length > 0) return error
  }
  return fallback
}

const responseJson = async (response: Response): Promise<typeof Schema.Json.Type> => {
  const source = await response.text()
  return source.trim().length === 0 ? {} : decodeJsonText(source)
}

const sessionToken = (header: string | null): string => {
  const match = /(?:^|;\s*)wf_session=([^;]+)/.exec(header ?? "")
  if (match?.[1] === undefined) {
    throw cliError("The gateway accepted the login but did not return a session")
  }
  return match[1]
}

export const loginOperator = async (input: {
  readonly email: string
  readonly password: string
}): Promise<OperatorSession> => {
  const url = await resolveGatewayUrl()
  const response = await fetch(`${url}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  })
  const payload = await responseJson(response)
  if (!response.ok) {
    throw cliError(messageFrom(payload, `Login failed with ${response.status}`))
  }
  const session = Schema.decodeUnknownSync(OperatorSession)({
    url,
    token: sessionToken(response.headers.get("set-cookie")),
    email: input.email
  })
  await writeOperatorSession(session)
  return session
}

export const signupOperator = async (input: {
  readonly email: string
  readonly password: string
  readonly tenantName?: string
}): Promise<OperatorSession> => {
  const url = await resolveGatewayUrl()
  const response = await fetch(`${url}/v1/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  })
  const payload = await responseJson(response)
  if (!response.ok) {
    throw cliError(messageFrom(payload, `Signup failed with ${response.status}`))
  }
  const session = Schema.decodeUnknownSync(OperatorSession)({
    url,
    token: sessionToken(response.headers.get("set-cookie")),
    email: input.email
  })
  await writeOperatorSession(session)
  return session
}

export interface ControlPlaneClient {
  readonly url: string
  request(
    method: "GET" | "POST" | "DELETE",
    route: string,
    body?: typeof Schema.Json.Type
  ): Promise<typeof Schema.Json.Type>
}

export const connectToControlPlane = async (): Promise<ControlPlaneClient> => {
  const session = await readOperatorSession()
  if (session === undefined) {
    const connection = await resolveClientConnection()
    if (connection === undefined) {
      throw cliError(
        "No operator credential found. Sign in with `ii login <email>`, or configure an administrative API key."
      )
    }
    return {
      url: connection.url,
      request: async (method, route, body) => {
        const response = await fetch(`${connection.url}${route}`, {
          method,
          headers: {
            authorization: `Bearer ${connection.apiKey}`,
            ...whenPresentMap("content-type", body, () => "application/json")
          },
          ...whenPresentMap("body", body, JSON.stringify)
        })
        const payload = await responseJson(response)
        if (!response.ok) {
          throw cliError(messageFrom(payload, `${method} ${route} failed with ${response.status}`))
        }
        return payload
      }
    }
  }
  const selectedUrl = await resolveGatewayUrl()
  if (selectedUrl !== session.url) {
    throw cliError(
      `The saved session belongs to ${session.url}, but the selected gateway is ${selectedUrl}. Run \`ii login\` again.`
    )
  }
  return {
    url: session.url,
    request: async (method, route, body) => {
      const response = await fetch(`${session.url}${route}`, {
        method,
        headers: {
          cookie: `wf_session=${session.token}`,
          origin: session.url,
          ...whenPresentMap("content-type", body, () => "application/json")
        },
        ...whenPresentMap("body", body, JSON.stringify)
      })
      const payload = await responseJson(response)
      if (!response.ok) {
        throw cliError(messageFrom(payload, `${method} ${route} failed with ${response.status}`))
      }
      return payload
    }
  }
}

/** Uses the public client method surface with a human session as its transport.
 * This lets `ii` reuse the exact `i` command definitions for dashboard
 * provisioning without giving the public client a generic request escape. */
export const connectToOperatorGateway = async (): Promise<GatewayClient> => {
  const session = await readOperatorSession()
  if (session === undefined) {
    const connection = await resolveClientConnection()
    if (connection === undefined) {
      throw cliError(
        "No operator credential found. Sign in with `ii login <email>`, or configure an administrative API key."
      )
    }
    return createGatewayClient(connection)
  }
  const selectedUrl = await resolveGatewayUrl()
  if (selectedUrl !== session.url) {
    throw cliError(
      `The saved session belongs to ${session.url}, but the selected gateway is ${selectedUrl}. Run \`ii login\` again.`
    )
  }
  const sessionFetch = Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      const headers = new Headers(init?.headers)
      headers.delete("authorization")
      headers.set("cookie", `wf_session=${session.token}`)
      headers.set("origin", session.url)
      return await fetch(input, { ...init, headers })
    },
    { preconnect: globalThis.fetch.preconnect }
  )
  return createGatewayClient({
    url: session.url,
    apiKey: "operator-session-transport",
    fetch: sessionFetch
  })
}

export const logoutOperator = async (): Promise<void> => {
  const session = await readOperatorSession()
  if (session === undefined) return
  try {
    await fetch(`${session.url}/v1/auth/logout`, {
      method: "POST",
      headers: {
        cookie: `wf_session=${session.token}`,
        origin: session.url
      }
    })
  } finally {
    await clearOperatorSession()
  }
}
