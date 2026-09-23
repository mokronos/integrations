import { Plug } from "lucide-react"
import { useState } from "react"

import { Skeleton } from "@/components/ui/skeleton"
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
  const [failedHost, setFailedHost] = useState<string | undefined>()
  const [loadedHost, setLoadedHost] = useState<string | undefined>()

  if (host === undefined || failedHost === host) {
    return (
      <Plug
        aria-hidden
        className={cn("text-muted-foreground shrink-0", className)}
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <span className={cn("relative inline-block shrink-0", className)} style={{ width: size, height: size }}>
      {loadedHost === host ? null : <Skeleton className="absolute inset-0 size-full" />}
      <img
        src={logoUrl(host, size)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onLoad={() => setLoadedHost(host)}
        onError={() => setFailedHost(host)}
        className={cn("rounded-sm object-contain", loadedHost === host ? "opacity-100" : "opacity-0")}
        style={{ width: size, height: size }}
      />
    </span>
  )
}
