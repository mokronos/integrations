import { Option } from "effect"
import type { CompiledSecurityScheme } from "./openapi.ts"
import { whenPresent } from "./optional.ts"
import type { ExecutorAuthMethod, ExecutorAuthPlacement, ExecutorMcpProbe } from "./schemas.ts"

/** What an integration will accept as proof of authorization.
 *
 *  Both halves of the host arrive at the same shape from different evidence: an
 *  MCP endpoint tells us by how it refuses an anonymous request, and an OpenAPI
 *  document tells us by declaring security schemes. Deriving rather than
 *  hand-authoring is what keeps a connection form honest when a vendor changes
 *  its mind. */

const bearerPlacements: ReadonlyArray<ExecutorAuthPlacement> = [{
  carrier: "header",
  name: "Authorization",
  prefix: "Bearer "
}]

const basicPlacements: ReadonlyArray<ExecutorAuthPlacement> = [{
  carrier: "header",
  name: "Authorization",
  prefix: "Basic "
}]

export const noAuthMethod: ExecutorAuthMethod = {
  id: "none",
  label: "No authentication",
  kind: "none",
  template: "none"
}

/** The method an MCP endpoint's refusal implies. */
export const mcpAuthMethods = (
  probe: ExecutorMcpProbe,
  endpoint: string
): ReadonlyArray<ExecutorAuthMethod> => {
  if (!probe.requiresAuthentication) return [noAuthMethod]
  if (probe.requiresOAuth) {
    return [{
      id: "oauth2",
      label: "OAuth",
      kind: "oauth",
      template: "oauth2",
      oauth: {
        // The endpoint itself is the discovery root: RFC 9728 hangs the
        // protected-resource metadata off it, which then names the
        // authorization server.
        discoveryUrl: endpoint,
        supportsDynamicRegistration: probe.supportsDynamicRegistration
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
): Option.Option<ExecutorAuthMethod> => {
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
  // A scheme this host cannot place — `digest`, `negotiate` — is left out
  // rather than offered as something it would then fail to satisfy.
  return Option.none()
}

const apiKeyMethod = (
  scheme: CompiledSecurityScheme
): Option.Option<ExecutorAuthMethod> => {
  const carrier: "header" | "query" | "cookie" = Option.getOrElse(
    scheme.in,
    (): "header" | "query" | "cookie" => "header"
  )
  const name = Option.getOrElse(scheme.headerName, () => scheme.name)
  if (carrier === "cookie") {
    // A cookie-borne key would have to survive a redirect chain this host does
    // not manage, so it is not offered.
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
): Option.Option<ExecutorAuthMethod> => {
  const discoveryUrl = scheme.openIdConnectUrl
  const authorizationUrl = scheme.authorizationUrl
  const tokenUrl = scheme.tokenUrl
  if (
    Option.isNone(discoveryUrl) &&
    (Option.isNone(authorizationUrl) || Option.isNone(tokenUrl))
  ) {
    // Neither a discovery document nor a usable pair of endpoints: there is
    // nothing to start a flow against.
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

/** The methods a document's security schemes imply.
 *
 *  A document that declares nothing gets the `none` method, because an API with
 *  no security scheme is one anybody may call — and a connection still has to
 *  exist for its tools to be addressable. */
export const openApiAuthMethods = (
  schemes: ReadonlyArray<CompiledSecurityScheme>
): ReadonlyArray<ExecutorAuthMethod> => {
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

/** The method a connection was created against, when the integration still
 *  declares it. A template that has since disappeared is the catalog's way of
 *  saying the connection needs redoing. */
export const findAuthMethod = (
  methods: ReadonlyArray<ExecutorAuthMethod>,
  template: string
): Option.Option<ExecutorAuthMethod> =>
  Option.fromNullishOr(methods.find((method) => method.template === template))

/** Whether reaching this integration needs a credential at all. */
export const requiresAuthentication = (
  methods: ReadonlyArray<ExecutorAuthMethod>
): boolean => methods.length > 0 && !methods.some((method) => method.kind === "none")
