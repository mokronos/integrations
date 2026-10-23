import { HttpApiMiddleware } from "effect/http-api"
import {
  Forbidden,
  GatewayFailure,
  InvalidInput,
  PayloadTooLarge,
  RateLimited,
  Unauthorized
} from "@integragents/contracts"
import { Identity } from "./identity.ts"

/**
 * Who the caller is, resolved once per request. Declared apart from the layer
 * that resolves it so the API definition can name the middleware without
 * dragging the gateway's store into a browser bundle.
 */
export class Authority extends HttpApiMiddleware.Service<
  Authority,
  {
    provides: Identity
  }
>()("@integragents/gateway-api/Authority", {
  // Every request passes through here, so this is where a client learns what any call can end in.
  error: [Unauthorized, Forbidden, RateLimited, GatewayFailure, InvalidInput, PayloadTooLarge]
}) {}
