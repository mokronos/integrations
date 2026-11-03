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

export const integrationLogoUrl = (host: string): string => `https://integrations.sh/logo/${host}?sz=128`
