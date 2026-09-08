import { Plug } from "lucide-react"
import { useState } from "react"

import { cn } from "@/lib/utils"

const logoUrl = (host: string, size: number): string =>
  `https://integrations.sh/logo/${host}?sz=${size * 2}`

const hostLike = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/i

export const integrationHost = (integration: {
  readonly slug: string
  readonly displayUrl?: string | undefined
}): string | undefined => {
  const url = integration.displayUrl
  if (url !== undefined && URL.canParse(url)) return new URL(url).hostname
  const asHost = integration.slug.replaceAll("_", ".")
  return hostLike.test(asHost) ? asHost : undefined
}

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
