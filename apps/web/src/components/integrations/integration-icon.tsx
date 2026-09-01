import { Plug } from "lucide-react"
import { useState } from "react"

import { cn } from "@/lib/utils"

/** The logo proxy integrations.sh serves for a domain.
 *
 * The registry this dashboard already searches also answers for logos, and it
 * owns the fallbacks: an unknown domain comes back as a neutral lettered mark
 * rather than a 404, so a missing brand never renders as a broken image.
 *
 * Worth knowing: this is a request from the operator's browser to the registry,
 * carrying the domain of a configured integration. It is the same third party
 * `Search integrations.sh` already talks to, and the domains are public brands
 * — but it is a request that happens on page load rather than on a click. */
const logoUrl = (host: string, size: number): string =>
  `https://integrations.sh/logo/${host}?sz=${size * 2}`

const hostLike = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/i

/** Which host to ask for a logo.
 *
 * An integration's own URL is the honest answer where there is one. Failing
 * that, a slug is tried as a hostname — the discovery path derives slugs from
 * URLs, so `mcp_linear_app` really is `mcp.linear.app` — but only when it still
 * looks like one after the substitution, so a slug like `context7` asks for
 * nothing rather than asking for a domain that isn't. */
export const integrationHost = (integration: {
  readonly slug: string
  readonly displayUrl?: string | undefined
}): string | undefined => {
  const url = integration.displayUrl
  if (url !== undefined && URL.canParse(url)) return new URL(url).hostname
  const asHost = integration.slug.replaceAll("_", ".")
  return hostLike.test(asHost) ? asHost : undefined
}

/** An integration's mark, or a neutral plug when there is no host to ask about.
 *
 * Square and fixed-size at every call site: these sit at the start of rows that
 * have to line up, and a logo that changes the row's height is worse than no
 * logo at all. */
export function IntegrationIcon({
  host,
  size = 16,
  className
}: {
  readonly host: string | undefined
  readonly size?: number
  readonly className?: string
}) {
  const [failed, setFailed] = useState(false)

  if (host === undefined || failed) {
    return (
      <Plug
        aria-hidden
        className={cn("text-muted-foreground shrink-0", className)}
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <img
      src={logoUrl(host, size)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("shrink-0 rounded-sm object-contain", className)}
      style={{ width: size, height: size }}
    />
  )
}
