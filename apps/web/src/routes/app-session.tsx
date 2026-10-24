import { useEffect, useMemo, useRef, useState } from "react"
import { AppWindow } from "lucide-react"
import { useParams } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { Option, Schema } from "effect"
import { isCallToolResult } from "@modelcontextprotocol/client"
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/client"
import {
  AppBridge,
  buildAllowAttribute,
  PostMessageTransport,
  RESOURCE_MIME_TYPE
} from "@modelcontextprotocol/ext-apps/app-bridge"
import { AppContext, AppSessionId, gatewayVersion, mcpAppMimeType, whenPresent } from "@integragents/contracts"
import type { AppSession, ResourceContents } from "@integragents/contracts"

import { LoadingRows, Page, QueryError } from "@/components/page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import * as gateway from "@/lib/gateway"

const Domains = Schema.optional(Schema.Array(Schema.String))
const ViewMeta = Schema.Struct({
  ui: Schema.optional(
    Schema.Struct({
      csp: Schema.optional(
        Schema.Struct({
          connectDomains: Domains,
          resourceDomains: Domains,
          frameDomains: Domains,
          baseUriDomains: Domains
        })
      ),
      permissions: Schema.optional(
        Schema.Struct({
          camera: Schema.optional(Schema.Struct({})),
          microphone: Schema.optional(Schema.Struct({})),
          geolocation: Schema.optional(Schema.Struct({})),
          clipboardWrite: Schema.optional(Schema.Struct({}))
        })
      )
    })
  )
})
type ViewMeta = typeof ViewMeta.Type
const decodeViewMeta = Schema.decodeUnknownOption(ViewMeta)

/** A host domain list as CSP takes it: scheme and host only, nothing that could end the directive. */
const sources = (domains: ReadonlyArray<string> | undefined): string =>
  (domains ?? []).filter((domain) => /^https?:\/\/[a-z0-9.*:-]+$/i.test(domain)).join(" ")

/**
 * The extension's default policy, widened only by the domains the view
 * declared. A policy in the document itself can be tightened by the view's
 * own markup, never loosened.
 */
const contentSecurityPolicy = (meta: ViewMeta | undefined): string => {
  const csp = meta?.ui?.csp
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${sources(csp?.resourceDomains)}`,
    `style-src 'unsafe-inline' ${sources(csp?.resourceDomains)}`,
    `img-src data: ${sources(csp?.resourceDomains)}`,
    `font-src data: ${sources(csp?.resourceDomains)}`,
    `media-src data: ${sources(csp?.resourceDomains)}`,
    `connect-src ${sources(csp?.connectDomains) || "'none'"}`,
    `frame-src ${sources(csp?.frameDomains) || "'none'"}`,
    `base-uri ${sources(csp?.baseUriDomains) || "'none'"}`,
    "object-src 'none'"
  ].join("; ")
}

const withPolicy = (html: string, policy: string): string => {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}">`
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => `${head}${tag}`) : `${tag}${html}`
}

const htmlOf = (contents: ResourceContents): string =>
  "text" in contents
    ? contents.text
    : new TextDecoder().decode(Uint8Array.from(atob(contents.blob), (c) => c.charCodeAt(0)))

const toolResultOf = (value: typeof Schema.Json.Type): CallToolResult =>
  isCallToolResult(value)
    ? value
    : {
        content: [{ type: "text", text: "The gateway answered with something that is not a tool result." }],
        isError: true
      }

const wireContents = (contents: ResourceContents): ReadResourceResult["contents"][number] => ({
  uri: contents.uri,
  ...whenPresent("mimeType", contents.mimeType),
  ...whenPresent("_meta", contents.meta),
  ...("text" in contents ? { text: contents.text } : { blob: contents.blob })
})

/** The browser features the view asked for, in the shape the bridge builds an `allow` attribute from. */
const permissionsOf = (meta: ViewMeta | undefined) => {
  const asked = meta?.ui?.permissions
  return {
    ...whenPresent("camera", asked?.camera === undefined ? undefined : {}),
    ...whenPresent("microphone", asked?.microphone === undefined ? undefined : {}),
    ...whenPresent("geolocation", asked?.geolocation === undefined ? undefined : {}),
    ...whenPresent("clipboardWrite", asked?.clipboardWrite === undefined ? undefined : {})
  }
}

const darkMode = () => document.documentElement.classList.contains("dark")

/**
 * Hosts one MCP App view: an iframe with an opaque origin, so the view can
 * reach neither this page nor the session cookie, talking to the page only
 * through the extension's postMessage protocol. Every call and read it makes
 * goes to the gateway, which runs it as the session's profile.
 */
function AppFrame({ session, view }: { readonly session: AppSession; readonly view: ResourceContents }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [status, setStatus] = useState<string>()
  const meta = useMemo(() => Option.getOrUndefined(decodeViewMeta(view.meta ?? {})), [view])

  useEffect(() => {
    const target = frame.current?.contentWindow
    if (target === undefined || target === null) return
    const bridge = new AppBridge(
      null,
      { name: "integrations dashboard", version: gatewayVersion },
      {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        updateModelContext: { text: {}, structuredContent: {} },
        message: { text: {} }
      },
      {
        hostContext: {
          theme: darkMode() ? "dark" : "light",
          platform: "web",
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          containerDimensions: { maxHeight: 6000 }
        }
      }
    )
    bridge.oncalltool = async (params) =>
      toolResultOf(await gateway.callFromApp(session.id, params.name, decodeArguments(params.arguments ?? {})))
    bridge.onreadresource = async ({ uri }) => ({
      contents: (await gateway.readAppResource(session.id, uri)).map(wireContents)
    })
    bridge.onupdatemodelcontext = async (params) => {
      await gateway.setAppContext(session.id, decodeContext(params))
      setStatus("The app updated what the agent will read.")
      return {}
    }
    bridge.onmessage = async ({ content }) => {
      await gateway.sendAppMessage(session.id, decodeContent(content))
      setStatus("The app sent the agent a message. The agent reads it with `i app`.")
      return {}
    }
    bridge.onopenlink = async ({ url }) => {
      window.open(url, "_blank", "noopener,noreferrer")
      return {}
    }
    bridge.onsizechange = async ({ height }) => {
      if (height !== undefined && frame.current !== null) frame.current.style.height = `${height}px`
    }
    bridge.oninitialized = () => {
      void bridge.sendToolInput({ arguments: toArguments(session.arguments) })
      void bridge.sendToolResult(toolResultOf(session.result))
    }
    const page = withPolicy(htmlOf(view), contentSecurityPolicy(meta))
    void bridge.connect(new PostMessageTransport(target, target)).then(() => {
      if (frame.current !== null && frame.current.srcdoc !== page) frame.current.srcdoc = page
    })
    return () => {
      void bridge.close()
    }
  }, [session, view, meta])

  return (
    <div className="space-y-2">
      <iframe
        ref={frame}
        title={`${session.alias} ${session.tool}`}
        sandbox="allow-scripts allow-forms"
        allow={buildAllowAttribute(permissionsOf(meta))}
        className="h-[480px] w-full rounded-md border bg-white"
      />
      {status === undefined ? null : <p className="text-muted-foreground text-sm">{status}</p>}
    </div>
  )
}

const ArgumentsObject = Schema.Record(Schema.String, Schema.Json)
const toArguments = (value: typeof Schema.Json.Type) =>
  Option.getOrElse(Schema.decodeUnknownOption(ArgumentsObject)(value), () => ({}))
const decodeArguments = Schema.decodeUnknownSync(ArgumentsObject)
const decodeContext = Schema.decodeUnknownSync(AppContext, { onExcessProperty: "ignore" })
const decodeContent = Schema.decodeUnknownSync(Schema.Array(Schema.Json))

export function AppSessionRoute() {
  const { sessionId } = useParams()
  const id = AppSessionId.make(sessionId ?? "")
  const session = useQuery({ queryKey: ["app-session", id], queryFn: () => gateway.getAppSession(id) })
  const view = useQuery({
    queryKey: ["app-session", id, "view"],
    enabled: session.data !== undefined,
    queryFn: async () => {
      const [contents] = await gateway.readAppResource(id, session.data?.resourceUri ?? "")
      return contents ?? null
    }
  })
  const rendersApp = view.data?.mimeType === RESOURCE_MIME_TYPE || view.data?.mimeType === mcpAppMimeType

  return (
    <Page
      title={
        <>
          <AppWindow className="size-5" />
          {session.data === undefined ? "App" : `${session.data.tool}`}
        </>
      }
      description="A tool result, shown in the app its server made for it. What you do here runs as the agent's profile, under its decisions, and is recorded as yours."
    >
      <QueryError error={session.error ?? view.error} />
      {session.isPending || view.isPending ? (
        <LoadingRows />
      ) : session.data === undefined || view.data === undefined ? null : view.data !== null && rendersApp ? (
        <AppFrame session={session.data} view={view.data} />
      ) : (
        <Alert>
          <AlertTitle>Not an app</AlertTitle>
          <AlertDescription>The tool's server did not serve its view as an MCP App.</AlertDescription>
        </Alert>
      )}
    </Page>
  )
}
