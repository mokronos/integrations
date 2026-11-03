import { Effect, Option, Schema } from "effect"
import {
  GatewayError,
  IntegrationSlug,
  integrationHost,
  integrationLogoUrl,
  presentError
} from "@integragents/contracts"
import { Integrations } from "@integragents/integrations"

/** What the provider put on the redirect when it refused, as RFC 6749 §4.1.2.1 names it. */
export interface ProviderRefusal {
  readonly error: string
  readonly description?: string | undefined
  readonly uri?: string | undefined
}

export const providerRefusalOf = (params: {
  readonly error?: string | undefined
  readonly error_description?: string | undefined
  readonly error_uri?: string | undefined
}): ProviderRefusal | undefined =>
  params.error === undefined
    ? undefined
    : { error: params.error, description: params.error_description, uri: params.error_uri }

/** The service on the other side of the flow, drawn next to the gateway's mark. */
export interface PageIntegration {
  readonly name: string
  readonly logoUrl?: string | undefined
}

export const pageIntegration = Effect.fn("OAuth.pageIntegration")(function* (slug: string) {
  const integrations = yield* Integrations
  const decoded = Schema.decodeUnknownOption(IntegrationSlug)(slug)
  const found = Option.isNone(decoded)
    ? Option.none()
    : yield* integrations.findIntegration(decoded.value).pipe(
        Effect.tapError((error) => Effect.logWarning("Could not look up the integration for its logo", error)),
        Effect.orElseSucceed(() => Option.none())
      )
  const host = integrationHost(Option.getOrElse(found, () => ({ slug })))
  return {
    name: Option.match(found, { onNone: () => slug, onSome: (integration) => integration.name }),
    logoUrl: host === undefined ? undefined : integrationLogoUrl(host)
  } satisfies PageIntegration
})

export type BrowserPage =
  | {
      readonly outcome: "success"
      readonly title: string
      readonly message: string
      readonly integration?: PageIntegration | undefined
    }
  | {
      readonly outcome: "failure"
      readonly title: string
      readonly message: string
      readonly integration?: PageIntegration | undefined
      /** What the human was doing, e.g. "Connecting linear with OAuth". */
      readonly flow: string
      readonly traceId: string
      readonly error?: GatewayError | undefined
      readonly provider?: ProviderRefusal | undefined
    }

type FailurePage = Extract<BrowserPage, { readonly outcome: "failure" }>

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const encodeError = Schema.encodeSync(GatewayError)

const traceFiles = `"\${INTEGRATIONS_HOME:-$HOME/.integrations}"/logs`

const traceQueries = (traceId: string): string =>
  [
    `jq -r --arg t ${traceId} 'select(.traceId == $t and .outcome == "failure") | .name + "\\n" + .cause' ${traceFiles}/gateway.trace.ndjson*`,
    `jq -c --arg t ${traceId} 'select(.traceId == $t) | {service, name, outcome, durationMs, events: [.events[]?.name]}' ${traceFiles}/*.trace.ndjson*`
  ].join("\n")

const providerLine = (provider: ProviderRefusal): string =>
  [
    `error=${provider.error}`,
    ...(provider.description === undefined ? [] : [`error_description=${provider.description}`]),
    ...(provider.uri === undefined ? [] : [`error_uri=${provider.uri}`])
  ].join(", ")

const facts = (page: FailurePage): ReadonlyArray<string> => {
  const presented = page.error === undefined ? undefined : presentError(page.error)
  return [
    `Flow: ${page.flow}`,
    `Shown in the browser: ${page.title}. ${page.message}`,
    ...(presented === undefined
      ? []
      : [
          `Error: ${presented.message}`,
          ...(presented.hint === undefined ? [] : [`Suggested next step: ${presented.hint}`]),
          `Code: ${presented.code} (HTTP ${presented.status}), retryable: ${presented.retryable ? "yes" : "no"}`
        ]),
    ...(page.provider === undefined ? [] : [`Provider redirected back with: ${providerLine(page.provider)}`]),
    `Trace id: ${page.traceId}`
  ]
}

const errorJson = (error: GatewayError | undefined): ReadonlyArray<string> =>
  error === undefined ? [] : ["", "Full error:", JSON.stringify(encodeError(error), null, 2)]

const rawReport = (page: FailurePage): string =>
  [
    ...facts(page),
    ...errorJson(page.error),
    "",
    "Trace lookup (local gateway; on Cloudflare search Workers Logs for the trace id):",
    traceQueries(page.traceId)
  ].join("\n")

const agentPrompt = (page: FailurePage): string =>
  [
    `${page.flow} failed in my integrations gateway. Find out why and fix it.`,
    "",
    ...facts(page),
    "",
    "Every span the gateway ran for this is in its trace file, keyed by the trace id. Read it before changing anything:",
    "",
    traceQueries(page.traceId),
    "",
    "On a Cloudflare-hosted gateway, search Workers Logs for the trace id instead.",
    "",
    "Tell me whether the cause is the provider, the OAuth client setup, or the gateway itself. Fix it, then run the flow again and confirm it succeeds.",
    ...errorJson(page.error)
  ].join("\n")

const icon = (outcome: BrowserPage["outcome"]): string =>
  outcome === "success"
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>`

const gatewayMark = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0a0a0a"/><rect x="1" y="1" width="30" height="30" rx="6" fill="none" stroke="#e8620c" stroke-opacity="0.5"/><path d="M11 22.5v-5.2l-2.6-2.6 2.6-2.6V6.9h3v4.4l2 2 2-2V6.9h3v5.2l2.6 2.6-2.6 2.6v5.2h-3v-4.4l-2-2-2 2v4.4z" fill="#f97316"/></svg>`

const plug = `<svg class="plug" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>`

const integrationTile = (integration: PageIntegration): string =>
  `<div class="tile">${plug}${
    integration.logoUrl === undefined
      ? ""
      : `<img src="${escapeHtml(integration.logoUrl)}" alt="" width="40" height="40" onerror="this.remove()">`
  }</div>`

const header = (page: BrowserPage): string =>
  page.integration === undefined
    ? `<div class="badge">${icon(page.outcome)}</div>`
    : `<div class="pair" role="img" aria-label="Integrations ${page.outcome === "success" ? "connected to" : "could not connect to"} ${escapeHtml(page.integration.name)}">
<figure><div class="tile mark">${gatewayMark}</div><figcaption>Integrations</figcaption></figure>
<div class="link"><span class="line"></span><div class="badge">${icon(page.outcome)}</div><span class="line"></span></div>
<figure>${integrationTile(page.integration)}<figcaption>${escapeHtml(page.integration.name)}</figcaption></figure>
</div>`

const copyBlock = (id: string, label: string, text: string): string => `<div class="block">
<div class="block-head"><span>${label}</span><button type="button" data-copy="${id}">Copy</button></div>
<pre id="${id}">${escapeHtml(text)}</pre>
</div>`

const diagnostics = (page: FailurePage): string => {
  const hint = page.error === undefined ? undefined : presentError(page.error).hint
  return `${hint === undefined ? "" : `<p class="hint">${escapeHtml(hint)}</p>`}
<section>
<h2>Fix it with an agent</h2>
<p class="muted">Paste this into a coding agent with access to the gateway's machine.</p>
${copyBlock("prompt", "Prompt", agentPrompt(page))}
</section>
<section>
<h2>Raw error and trace</h2>
<p class="muted">The same facts without instructions, for your own debugging or an issue.</p>
${copyBlock("raw", "Details", rawReport(page))}
</section>`
}

const style = `:root{--bg:#f6f7f9;--card:#fff;--fg:#14161a;--muted:#5d6470;--line:#e2e5ea;--code:#f1f3f6;--ok:#15803d;--ok-bg:#dcfce7;--bad:#b91c1c;--bad-bg:#fee2e2;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--fg:#e8eaee;--muted:#9aa2ae;--line:#2a2f38;--code:#11141a;--ok:#4ade80;--ok-bg:#14301f;--bad:#f87171;--bad-bg:#3a1717;--accent:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:flex-start;justify-content:center;padding:10vh 16px 48px}
main{width:100%;max-width:44rem;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px}
.badge{width:44px;height:44px;flex:none;border-radius:50%;display:grid;place-items:center;margin-bottom:16px}
.pair{display:flex;align-items:flex-start;justify-content:center;gap:8px;margin:4px 0 28px}
.pair .badge{width:32px;height:32px;margin:0}
.pair .badge svg{width:18px;height:18px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:8px;width:96px}
figcaption{font-size:13px;color:var(--muted);text-align:center;overflow-wrap:anywhere}
.tile{position:relative;width:64px;height:64px;border-radius:16px;border:1px solid var(--line);background:#fff;display:grid;place-items:center;overflow:hidden}
.tile img{position:absolute;inset:12px;width:40px;height:40px;object-fit:contain}
.tile.mark{border:0;background:none}
.tile.mark svg{width:64px;height:64px}
.plug{width:28px;height:28px;fill:none;stroke:#5d6470;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.link{display:flex;align-items:center;gap:6px;height:64px}
.line{width:40px;border-top:2px solid var(--ok)}
.failure .line{border-top:2px dashed var(--bad)}
.badge svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.success .badge{background:var(--ok-bg);color:var(--ok)}
.failure .badge{background:var(--bad-bg);color:var(--bad)}
h1{font-size:22px;line-height:1.3;margin:0 0 8px}
h2{font-size:15px;margin:0 0 4px}
p{margin:0 0 12px;overflow-wrap:anywhere}
.muted{color:var(--muted)}
.pair~.intro{text-align:center}
.hint{border-left:3px solid var(--accent);padding:2px 0 2px 12px}
section{margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}
.block{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:8px}
.block-head{display:flex;justify-content:space-between;align-items:center;padding:6px 8px 6px 12px;background:var(--code);border-bottom:1px solid var(--line);font-size:13px;color:var(--muted)}
button{font:inherit;font-size:13px;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:3px 10px;cursor:pointer}
button:hover{border-color:var(--muted)}
pre{margin:0;padding:12px;max-height:16rem;overflow:auto;background:var(--code);font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
`

const copyScript = `document.querySelectorAll("[data-copy]").forEach(function(button){button.addEventListener("click",function(){var text=document.getElementById(button.dataset.copy).textContent;navigator.clipboard.writeText(text).then(function(){button.textContent="Copied";setTimeout(function(){button.textContent="Copy"},1500)},function(){var range=document.createRange();range.selectNodeContents(document.getElementById(button.dataset.copy));var selection=getSelection();selection.removeAllRanges();selection.addRange(range)})})})`

export const oauthBrowserPage = (page: BrowserPage): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(page.title)}</title>
<style>${style}</style>
</head>
<body>
<main class="${page.outcome}">
${header(page)}
<div class="intro">
<h1>${escapeHtml(page.title)}</h1>
<p class="muted">${escapeHtml(page.message)}</p>
</div>
${page.outcome === "failure" ? diagnostics(page) : ""}
</main>
${page.outcome === "failure" ? `<script>${copyScript}</script>` : ""}
</body>
</html>`
