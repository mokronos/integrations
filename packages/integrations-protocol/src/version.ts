import { Schema } from "effect"

/** Increment only when a client and gateway can no longer communicate safely. */
export const gatewayProtocolVersion = 1

export const GatewayMetadata = Schema.Struct({
  ok: Schema.Literal(true),
  protocolVersion: Schema.Int,
  gatewayVersion: Schema.String
})
export type GatewayMetadata = typeof GatewayMetadata.Type
