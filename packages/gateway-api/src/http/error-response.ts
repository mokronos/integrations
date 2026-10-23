import { Schema } from "effect"
import { HttpServerResponse } from "effect/http"
import { GatewayError, presentError } from "@integragents/contracts"

const encodeError = Schema.encodeSync(GatewayError)

/** An error answered outside an endpoint's own handler, in the shape every endpoint answers with. */
export const errorResponse = (error: GatewayError): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(encodeError(error), { status: presentError(error).status })
