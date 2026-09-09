import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { ForbiddenError, Identity, UnauthorizedError } from "./identity.ts"

/**
 * Who the caller is, resolved once per request. Declared apart from the layer
 * that resolves it so the API definition can name the middleware without
 * dragging the gateway's store into a browser bundle.
 */
export class Authority extends HttpApiMiddleware.Service<Authority, {
  provides: Identity
}>()("@mokronos/integrations/Authority", {
  error: [UnauthorizedError, ForbiddenError]
}) {}
