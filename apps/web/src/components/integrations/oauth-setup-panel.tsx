import { ExternalLink } from "lucide-react"

import { CopyField } from "@/components/ui/copy-field"
import {
  type AuthMethod
} from "@/lib/schemas"
/** Credential entry. OAuth is deliberately a different path: the gateway drives
 *  the flow and hosts the callback, because it is what holds the credential.
 *
 *  Providers without dynamic client registration (Google, Microsoft) refuse to
 *  authorize until an OAuth application exists at their console with our
 *  redirect URI in it, so the dialog walks through that setup instead of
 *  failing later with an opaque provider error. */
type OAuthProvider = "google" | "microsoft" | "other"

const oauthProviderOf = (method: AuthMethod): OAuthProvider => {
  const hosts = [method.oauth?.authorizationUrl, method.oauth?.tokenUrl, method.oauth?.discoveryUrl]
    .filter((url): url is string => url !== undefined)
    .map((url) => {
      try {
        return new URL(url).hostname.toLowerCase()
      } catch {
        return ""
      }
    })
  if (hosts.some((host) => host.endsWith("googleapis.com") || host.endsWith("google.com"))) {
    return "google"
  }
  if (
    hosts.some((host) =>
      host.endsWith("microsoftonline.com") || host.endsWith("microsoft.com") ||
      host.endsWith("live.com")
    )
  ) {
    return "microsoft"
  }
  return "other"
}

const providerSetupSteps = {
  google: [
    "Google Cloud Console > APIs & Services > Library: enable this API.",
    "OAuth consent screen: add the scopes this connection requests.",
    "Credentials > Create credentials > OAuth client ID, type \"Web application\"."
  ],
  microsoft: [
    "portal.azure.com > Microsoft Entra ID > App registrations > New registration.",
    "Redirect URI: pick Web and paste the URI below.",
    "Certificates & secrets: create one and copy the secret Value.",
    "API permissions: add this connection's delegated scopes."
  ],
  other: [
    "Create an OAuth application at the provider's developer console.",
    "Register the redirect URI below on that application.",
    "Copy the client ID and, when the provider issues one, its secret."
  ]
} as const

const providerConsoleUrl = {
  google: "https://console.cloud.google.com/apis/credentials",
  microsoft: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  other: ""
}

export function OAuthSetupPanel({
  method,
  callbackUrl
}: {
  readonly method: AuthMethod
  readonly callbackUrl: string | undefined
}) {
  const provider = oauthProviderOf(method)
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-sm sm:col-span-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Before authorizing</span>
        {providerConsoleUrl[provider].length > 0 && (
          <a
            className="text-muted-foreground inline-flex items-center gap-1 text-xs underline underline-offset-2"
            href={providerConsoleUrl[provider]}
            target="_blank"
            rel="noreferrer"
          >
            Open the {provider === "google" ? "Google" : "Azure"} console
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        This provider does not support dynamic client registration, so a redirect
        URI must be registered there first — exactly as written:
      </p>
      {callbackUrl === undefined
        ? <p className="text-muted-foreground rounded border bg-background px-2 py-1 text-xs">
          unavailable — start the gateway with a public URL or on loopback
        </p>
        : <CopyField value={callbackUrl} label="Redirect URI" />}
      <ol className="text-muted-foreground list-decimal space-y-0.5 pl-5 text-xs">
        {providerSetupSteps[provider].map((step) => <li key={step}>{step}</li>)}
      </ol>
    </div>
  )
}
