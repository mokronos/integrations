import { authenticateClient, authorizeMutation } from "../authorize.ts"
import type { GatewayStore } from "../store.ts"
import { matchRoute, pathExists, RequestBodyError } from "./router.ts"
import type { Route } from "./router.ts"

const json = (status: number, body: unknown): Response =>
  new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  })

/** `Authorization: Bearer <key>`, or the `x-api-key` header. Nothing reads a
 *  key from the query string, where it would land in access logs. */
const presentedSecret = (request: Request): string | undefined => {
  const header = request.headers.get("authorization")
  if (header !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match?.[1] !== undefined) return match[1]
  }
  const apiKey = request.headers.get("x-api-key")
  return apiKey === null || apiKey.length === 0 ? undefined : apiKey
}

const readBody = async (request: Request): Promise<unknown> => {
  if (request.method === "GET" || request.method === "DELETE") return undefined
  const text = await request.text()
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new RequestBodyError("Request body is not valid JSON")
  }
}

const authenticationStatus: Record<string, number> = {
  "unknown-key": 401,
  "key-revoked": 401,
  "client-revoked": 403,
  "not-permitted": 403
}

export interface HandlerDependencies {
  readonly store: GatewayStore
  readonly routes: ReadonlyArray<Route>
}

/** What the server knows about a request that the request itself cannot say.
 *
 * `localSecret` is the local client's key, and is set only by a server that has
 * already decided this request may borrow it — see `http/loopback.ts`. The
 * handler does not re-derive that decision, so a caller cannot reach it by
 * setting a header. */
export interface GatewayRequestContext {
  readonly localSecret?: string
}

/** Turns a Request into a Response with no socket involved, so the whole
 * surface — including every rejection path — is testable directly.
 *
 * Access is enforced here rather than in handlers: a route declares whether it
 * is delegated or privileged, and a new endpoint cannot forget to check. */
export const createGatewayHandler = (
  dependencies: HandlerDependencies
): ((request: Request, context?: GatewayRequestContext) => Promise<Response>) =>
async (request, context) => {
  const url = new URL(request.url)

  if (url.pathname === "/v1/health") {
    return json(200, { ok: true })
  }

  const match = matchRoute(dependencies.routes, request.method, url.pathname)
  if (match === undefined) {
    return pathExists(dependencies.routes, url.pathname)
      ? json(405, { error: `${request.method} is not allowed on ${url.pathname}` })
      : json(404, { error: `No route for ${request.method} ${url.pathname}` })
  }

  // An explicit key always wins: a caller that presented one gets its own
  // identity and its own grants, never the local client's.
  const secret = presentedSecret(request) ?? context?.localSecret
  if (secret === undefined) {
    return json(401, { error: "An API key is required" })
  }

  // Privileged routes ask a different question than delegated ones: not "may
  // you invoke this" but "may you change what is invocable".
  if (match.route.access === "privileged") {
    const authorization = await authorizeMutation(dependencies.store, secret)
    if (authorization.status !== "authorized") {
      return json(authenticationStatus[authorization.status] ?? 403, {
        error: authorization.status === "not-permitted"
          ? "This key may not change the catalog, connections, grants, or policy"
          : authorization.status
      })
    }
    return await dispatch(match.route, request, url, authorization.client, secret)
  }

  const authentication = await authenticateClient(dependencies.store, secret)
  if (authentication.status !== "authenticated") {
    return json(authenticationStatus[authentication.status] ?? 401, {
      error: authentication.status
    })
  }
  return await dispatch(match.route, request, url, authentication.client, secret)

  async function dispatch(
    route: Route,
    incoming: Request,
    location: URL,
    client: Parameters<Route["handle"]>[0]["client"],
    presented: string
  ): Promise<Response> {
    try {
      const result = await route.handle({
        params: match?.params ?? {},
        query: location.searchParams,
        body: await readBody(incoming),
        client,
        secret: presented
      })
      return json(result.status, result.body)
    } catch (error) {
      if (error instanceof RequestBodyError) return json(400, { error: error.message })
      return json(500, {
        error: error instanceof Error ? error.message : "Gateway request failed"
      })
    }
  }
}
