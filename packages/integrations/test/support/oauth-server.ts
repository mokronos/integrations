import { whenPresent } from "@integragents/contracts"
import { Effect, Schema } from "effect"
import type { Scope } from "effect"

const Registration = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)]))

export interface FakeAuthorizationServerOptions {
  /** `token_endpoint_auth_methods_supported`; omitted when undefined. */
  readonly authMethods?: ReadonlyArray<string>
  readonly cimd?: boolean
  /** Answer dynamic registration with 200 instead of RFC 7591's 201. */
  readonly registrationStatus?: 200 | 201
  /** Where the protected resource names its metadata; `false` publishes no challenge. */
  readonly challenge?: boolean
  /** The resource the metadata claims to protect, relative to the server's origin. */
  readonly resourcePath?: string
  readonly scopes?: ReadonlyArray<string>
  /** Answer token requests with this body and status instead of issuing tokens. */
  readonly tokenFailure?: { readonly status: number; readonly body: Record<string, string> }
  /** Delay before answering refresh grants, so concurrent callers overlap. */
  readonly refreshDelayMs?: number
  /** A Slack-style `oauth.v2.access` envelope for the code exchange. */
  readonly slackEnvelope?: boolean
}

export interface FakeAuthorizationServer {
  readonly origin: string
  readonly endpoint: string
  readonly registrations: Array<Record<string, string | ReadonlyArray<string>>>
  readonly tokenRequests: Array<{
    readonly grant: string
    readonly body: URLSearchParams
    readonly authorization: string | null
  }>
  /** The refresh tokens the server still honours; rotating spends each once. */
  readonly liveRefreshTokens: Set<string>
}

/**
 * An OAuth authorization server and MCP-style protected resource on a
 * loopback port: RFC 9728 metadata behind a Bearer challenge, RFC 8414
 * metadata, dynamic registration and rotating refresh tokens.
 */
export const fakeAuthorizationServer = (
  options: FakeAuthorizationServerOptions = {}
): Effect.Effect<FakeAuthorizationServer, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const registrations: FakeAuthorizationServer["registrations"] = []
      const tokenRequests: FakeAuthorizationServer["tokenRequests"] = []
      const liveRefreshTokens = new Set<string>()
      let issued = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const url = new URL(request.url)
          const origin = url.origin
          const metadataUrl = `${origin}/metadata/protected-resource`
          if (url.pathname === "/mcp") {
            return new Response(null, {
              status: 401,
              headers:
                options.challenge === false
                  ? {}
                  : { "www-authenticate": `Bearer resource_metadata="${metadataUrl}", scope="read"` }
            })
          }
          if (url.pathname === "/metadata/protected-resource") {
            return Response.json({
              resource: `${origin}${options.resourcePath ?? "/mcp"}`,
              authorization_servers: [origin],
              scopes_supported: ["read", "write"]
            })
          }
          if (url.pathname === "/.well-known/oauth-authorization-server") {
            return Response.json({
              issuer: origin,
              authorization_endpoint: `${origin}/authorize`,
              token_endpoint: `${origin}/token`,
              registration_endpoint: `${origin}/register`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
              scopes_supported: options.scopes ?? ["read", "write", "offline_access"],
              authorization_response_iss_parameter_supported: true,
              ...whenPresent("token_endpoint_auth_methods_supported", options.authMethods),
              ...whenPresent("client_id_metadata_document_supported", options.cimd)
            })
          }
          if (url.pathname === "/register") {
            const body = Schema.decodeUnknownSync(Registration)(await request.json())
            registrations.push(body)
            issued += 1
            return Response.json(
              {
                ...body,
                client_id: `client-${issued}`,
                ...whenPresent(
                  "client_secret",
                  body["token_endpoint_auth_method"] === "none" ? undefined : `secret-${issued}`
                )
              },
              { status: options.registrationStatus ?? 201 }
            )
          }
          if (url.pathname === "/token") {
            const body = new URLSearchParams(await request.text())
            const grant = body.get("grant_type") ?? ""
            tokenRequests.push({ grant, body, authorization: request.headers.get("authorization") })
            if (options.tokenFailure !== undefined) {
              return Response.json(options.tokenFailure.body, { status: options.tokenFailure.status })
            }
            if (grant === "refresh_token") {
              await Bun.sleep(options.refreshDelayMs ?? 0)
              const presented = body.get("refresh_token") ?? ""
              if (!liveRefreshTokens.delete(presented)) {
                return Response.json({ error: "invalid_grant" }, { status: 400 })
              }
            }
            issued += 1
            const refresh = `refresh-${issued}`
            liveRefreshTokens.add(refresh)
            if (options.slackEnvelope === true) {
              return Response.json({
                ok: true,
                access_token: "xoxb-bot",
                token_type: "bot",
                scope: "chat:write,channels:read",
                authed_user: { id: "U1", scope: "", access_token: "xoxp-user", token_type: "user" }
              })
            }
            return Response.json({
              access_token: `access-${issued}`,
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: refresh
            })
          }
          return new Response("Not found", { status: 404 })
        }
      })
      const origin = `http://127.0.0.1:${server.port}`
      return {
        server,
        fake: { origin, endpoint: `${origin}/mcp`, registrations, tokenRequests, liveRefreshTokens }
      }
    }),
    ({ server }) => Effect.promise(() => server.stop(true))
  ).pipe(Effect.map(({ fake }) => fake))
