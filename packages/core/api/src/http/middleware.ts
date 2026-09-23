import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { ForbiddenError, GatewayFailureError, Identity, UnauthorizedError } from "./identity.ts"

/**
 * Who the caller is, resolved once per request. Declared apart from the layer
 * that resolves it so the API definition can name the middleware without
 * dragging the gateway's store into a browser bundle.
 */
export class Authority extends HttpApiMiddleware.Service<Authority, {
  provides: Identity
}>()("@mokronos/integrations-gateway-api/Authority", {
  // Every request passes through here, so this is where a client learns any call can end in a 500.
  error: [UnauthorizedError, ForbiddenError, GatewayFailureError]
}) {}
