import { Option } from "effect"
import type { CompiledSecurityScheme } from "../openapi/compile.ts"
import { whenPresent } from "@mokronos/contracts"
import type { AuthMethod, AuthPlacement, McpProbe } from "@mokronos/contracts"

/** What an integration will accept as proof of authorization.
 *
 *  Both halves of the host arrive at the same shape from different evidence: an
 *  MCP endpoint tells us by how it refuses an anonymous request, and an OpenAPI
 *  document tells us by declaring security schemes. Deriving rather than
 *  hand-authoring is what keeps a connection form honest when a vendor changes
 *  its mind. */

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


/** Offered when an integration needs no credential at all. A connection still
 *  has to exist for its tools to be addressable. */
const noAuthMethod: AuthMethod = {
  id: "none",
  label: "No authentication",
  kind: "none",
  template: "none"
}

/** The method an MCP endpoint implies — by refusing an anonymous request, or by
 *  declaring an authorization server it never mentions until you call a tool. */
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
        // The endpoint itself is the discovery root: RFC 9728 hangs the
        // protected-resource metadata off it, which then names the
        // authorization server.
        discoveryUrl: endpoint,
        supportsDynamicRegistration: probe.supportsDynamicRegistration,
        // A provider without dynamic registration sends the operator to its
        // console to create a client by hand, and the setup guidance can only
        // name the scopes to enable there if the probe carried them here.
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
  // A scheme this host cannot place — `digest`, `negotiate` — is left out
  // rather than offered as something it would then fail to satisfy.
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
): Option.Option<AuthMethod> => {
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

/** The method a connection was created against, when the integration still
 *  declares it. A template that has since disappeared is the catalog's way of
 *  saying the connection needs redoing. */
export const findAuthMethod = (
  methods: ReadonlyArray<AuthMethod>,
  template: string
): Option.Option<AuthMethod> =>
  Option.fromNullishOr(methods.find((method) => method.template === template))

/** Whether reaching this integration needs a credential at all. */
export const requiresAuthentication = (
  methods: ReadonlyArray<AuthMethod>
): boolean => methods.length > 0 && !methods.some((method) => method.kind === "none")
