import type { ExecutorAuthMethod } from "@mokronos/integrations-executor"

const hostOf = (url: string | undefined): string | undefined => {
  try {
    return new URL(url ?? "").hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** Providers that demand a pre-registered OAuth client get provider-specific
 *  steps; everyone else gets the generic recipe. The redirect URI comes first
 *  in every variant, because it is the one value the console asks for that we
 *  already know — everything else the human reads off their own screen. */
export const oauthSetupGuidance = (input: {
  readonly integration: string
  readonly method: ExecutorAuthMethod
  readonly redirectUri: string
}): string => {
  const oauth = input.method.oauth ?? {}
  const host = hostOf(oauth.authorizationUrl) ??
    hostOf(oauth.discoveryUrl) ??
    hostOf(oauth.tokenUrl)
  const scopes = oauth.scopes ?? []
  const scopeLines = scopes.length === 0
    ? []
    : [`Scopes to request:\n${scopes.map((scope) => `  - ${scope}`).join("\n")}`]
  const retry =
    `Once the client exists, retry with its credentials:\n` +
    `  i connect ${input.integration} --client-id <client-id> --client-secret-env <ENV_VAR_NAME>`
  const preamble =
    `${input.integration} does not support dynamic client registration, so an ` +
    `OAuth application has to exist at the provider before authorizing.\n\n` +
    `Register this redirect URI exactly (scheme, host, port, path):\n  ${input.redirectUri}\n`

  if (host !== undefined && (host.endsWith("googleapis.com") || host.endsWith("google.com"))) {
    return [
      preamble,
      `Google setup (console.cloud.google.com):`,
      `  1. APIs & Services > Library: enable every API this integration uses.`,
      `  2. APIs & Services > OAuth consent screen: add the scopes below.`,
      `  3. APIs & Services > Credentials > Create credentials > OAuth client ID.`,
      `  4. Application type "Web application"; under Authorized redirect URIs add the URI above.`,
      ...scopeLines.map((line) => `\n${line}`),
      ``,
      retry
    ].join("\n")
  }
  if (
    host !== undefined &&
    (host.endsWith("microsoftonline.com") || host.endsWith("microsoft.com") ||
      host.endsWith("live.com"))
  ) {
    return [
      preamble,
      `Microsoft setup (portal.azure.com > Microsoft Entra ID):`,
      `  1. App registrations > New registration; name it after this integration.`,
      `  2. Under "Redirect URI", pick Web and add the URI above.`,
      `  3. Certificates & secrets > New client secret; copy the secret Value now.`,
      `  4. API permissions > Add a permission > the relevant API > Delegated:`,
      ...scopeLines.map((line) => `${line}`),
      ``,
      retry
    ].join("\n")
  }
  return [
    preamble,
    `Then create an OAuth client at ${host ?? "the provider's developer console"}`,
    `(application type "web") and note the client id and secret.`,
    ...scopeLines.map((line) => `\n${line}`),
    ``,
    retry
  ].join("\n")
}
