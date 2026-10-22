import { Schema } from "effect"

export const gatewayVersion = "0.3.1"

export const gatewayProtocolVersion = 3

export const GatewayMetadata = Schema.Struct({
  ok: Schema.Literal(true),
  protocolVersion: Schema.Int,
  gatewayVersion: Schema.String
})
export type GatewayMetadata = typeof GatewayMetadata.Type
