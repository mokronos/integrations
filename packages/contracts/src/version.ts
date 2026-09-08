import { Schema } from "effect"

export const gatewayProtocolVersion = 3

export const GatewayMetadata = Schema.Struct({
  ok: Schema.Literal(true),
  protocolVersion: Schema.Int,
  gatewayVersion: Schema.String
})
export type GatewayMetadata = typeof GatewayMetadata.Type
