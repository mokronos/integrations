/**
 * The gateway's on-disk config lives in contracts so the gateway itself can
 * read it without depending on this client. Re-exported here because it is
 * part of this package's published surface.
 */
export * from "@mokronos/contracts/gateway-config"
