import { Option } from "effect"
import type { CompiledSecurityScheme } from "../openapi/compile.ts"
import { whenPresent } from "@integrations/contracts"
import type { AuthMethod, AuthPlacement, McpProbe } from "@integrations/contracts"

const bearerPlacements: ReadonlyArray<AuthPlacement> = [{
  carrier: "header",
  name: "Authorization",
  prefix: "Bearer "
}]

const basicPlacements: ReadonlyArray<AuthPlacement> = [{
  carrier: "header",
  name: "Authorization",
  prefix: "Basic "
}]


const noAuthMethod: AuthMethod = {
  id: "none",
  label: "No authentication",
  kind: "none",
  template: "none"
}

export const mcpAuthMethods = (
  probe: McpProbe,
  endpoint: string
): ReadonlyArray<AuthMethod> => {
  if (!probe.requiresAuthentication) return [noAuthMethod]
  if (probe.requiresOAuth) {
    return [{
      id: "oauth2",
      label: "OAuth",
      kind: "oauth",
      template: "oauth2",
      oauth: {
        discoveryUrl: endpoint,
        supportsDynamicRegistration: probe.supportsDynamicRegistration,
        ...whenPresent("scopes", probe.scopes.length === 0 ? undefined : probe.scopes)
      }
    }]
  }
  return [{
    id: "bearer",
    label: "Bearer token",
    kind: "header",
    template: "bearer",
    placements: bearerPlacements
  }]
}

const httpSchemeMethod = (
  scheme: CompiledSecurityScheme
): Option.Option<AuthMethod> => {
  const kind = Option.getOrElse(scheme.scheme, () => "bearer").toLowerCase()
  if (kind === "basic") {
    return Option.some({
      id: scheme.name,
      label: `${scheme.name} (HTTP basic)`,
      kind: "header",
      template: scheme.name,
      placements: basicPlacements
    })
  }
  if (kind === "bearer") {
    return Option.some({
      id: scheme.name,
      label: `${scheme.name} (bearer token)`,
      kind: "header",
      template: scheme.name,
      placements: bearerPlacements
    })
  }
  return Option.none()
}

const apiKeyMethod = (
  scheme: CompiledSecurityScheme
): Option.Option<AuthMethod> => {
  const carrier: "header" | "query" | "cookie" = Option.getOrElse(
    scheme.in,
    (): "header" | "query" | "cookie" => "header"
  )
  const name = Option.getOrElse(scheme.headerName, () => scheme.name)
  if (carrier === "cookie") {
    return Option.none()
  }
  return Option.some({
    id: scheme.name,
    label: `${scheme.name} (API key in ${carrier})`,
    kind: "apikey",
    template: scheme.name,
    placements: [{ carrier, name, prefix: "" }]
  })
}

const oauthMethod = (
  scheme: CompiledSecurityScheme
): Option.Option<AuthMethod> => {
  const discoveryUrl = scheme.openIdConnectUrl
  const authorizationUrl = scheme.authorizationUrl
  const tokenUrl = scheme.tokenUrl
  if (
    Option.isNone(discoveryUrl) &&
    (Option.isNone(authorizationUrl) || Option.isNone(tokenUrl))
  ) {
    return Option.none()
  }
  return Option.some({
    id: scheme.name,
    label: `${scheme.name} (OAuth)`,
    kind: "oauth",
    template: scheme.name,
    oauth: {
      ...whenPresent("discoveryUrl", Option.getOrUndefined(discoveryUrl)),
      ...whenPresent("authorizationUrl", Option.getOrUndefined(authorizationUrl)),
      ...whenPresent("tokenUrl", Option.getOrUndefined(tokenUrl)),
      ...whenPresent("scopes", scheme.scopes.length === 0 ? undefined : scheme.scopes)
    }
  })
}

export const openApiAuthMethods = (
  schemes: ReadonlyArray<CompiledSecurityScheme>
): ReadonlyArray<AuthMethod> => {
  const methods = schemes.flatMap((scheme) => {
    switch (scheme.type) {
      case "http":
        return Option.toArray(httpSchemeMethod(scheme))
      case "apiKey":
        return Option.toArray(apiKeyMethod(scheme))
      case "oauth2":
      case "openIdConnect":
        return Option.toArray(oauthMethod(scheme))
    }
  })
  return methods.length === 0 ? [noAuthMethod] : methods
}

export const findAuthMethod = (
  methods: ReadonlyArray<AuthMethod>,
  template: string
): Option.Option<AuthMethod> =>
  Option.fromNullishOr(methods.find((method) => method.template === template))

export const requiresAuthentication = (
  methods: ReadonlyArray<AuthMethod>
): boolean => methods.length > 0 && !methods.some((method) => method.kind === "none")
