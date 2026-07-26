import type {
  ConnectionManager,
  OAuthClientConfiguration,
  OAuthConnection
} from "../connections.ts"

export const openBrowser = (url: string): void => {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url]
  Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
}

export interface AuthorizeMcpInBrowserOptions {
  readonly manager: ConnectionManager
  readonly connectionId: string
  readonly resource: string
  readonly scopes?: ReadonlyArray<string>
  readonly client?: OAuthClientConfiguration
  readonly open?: (url: string) => void | Promise<void>
  readonly onAuthorizationUrl?: (url: string) => void
  readonly timeoutMs?: number
}

const browserResponse = (options: {
  readonly title: string
  readonly message: string
  readonly status?: number
}): Response => new Response(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${options.title}</title></head>
<body style="font:16px system-ui,sans-serif;max-width:38rem;margin:12vh auto;padding:0 1.5rem;line-height:1.5">
<h1>${options.title}</h1><p>${options.message}</p>
</body>
</html>`, {
  status: options.status ?? 200,
  headers: { "content-type": "text/html; charset=utf-8" }
})

export const authorizeMcpInBrowser = async (
  options: AuthorizeMcpInBrowserOptions
): Promise<OAuthConnection> => {
  const completion = Promise.withResolvers<OAuthConnection>()
  let attempt: Awaited<ReturnType<ConnectionManager["beginMcpOAuth"]>> | undefined
  let callbackStarted = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      if (request.method !== "GET" || url.pathname !== "/oauth/callback") {
        return new Response("Not found", { status: 404 })
      }
      if (attempt === undefined || callbackStarted) {
        return browserResponse({
          title: "Authorization unavailable",
          message: "This authorization callback is no longer active. Return to the terminal and try again.",
          status: 409
        })
      }
      callbackStarted = true
      try {
        const connection = await attempt.complete(url.toString())
        setTimeout(() => completion.resolve(connection), 0)
        return browserResponse({
          title: "Account connected",
          message: "Authorization completed. You can close this window and return to wf."
        })
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        setTimeout(() => completion.reject(failure), 0)
        return browserResponse({
          title: "Authorization failed",
          message: "The callback could not be verified. Return to the terminal for details and try again.",
          status: 400
        })
      }
    }
  })
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 300_000)
  const timeout = setTimeout(
    () => completion.reject(new Error(`OAuth authorization timed out after ${Math.ceil(timeoutMs / 1000)} seconds`)),
    timeoutMs
  )

  try {
    const redirectUri = `http://127.0.0.1:${server.port}/oauth/callback`
    attempt = await options.manager.beginMcpOAuth({
      connectionId: options.connectionId,
      resource: options.resource,
      redirectUri,
      ...(options.scopes === undefined ? {} : { scopes: options.scopes }),
      ...(options.client === undefined ? {} : { client: options.client })
    })
    options.onAuthorizationUrl?.(attempt.authorizationUrl)
    await (options.open ?? openBrowser)(attempt.authorizationUrl)
    return await completion.promise
  } finally {
    clearTimeout(timeout)
    server.stop(true)
  }
}
