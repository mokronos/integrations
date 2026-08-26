/** The contracts every component of this system agrees on: the shared
 *  vocabulary, the wire shapes, and the helpers used at every boundary.
 *
 *  Depends on `effect` and nothing else, so a browser or a published client can
 *  decode a gateway response without acquiring the host's dependency graph. */
export * from "./address.ts"
export * from "./connection.ts"
export * from "./discovery.ts"
export * from "./integration.ts"
export * from "./json.ts"
export * from "./oauth.ts"
export * from "./optional.ts"
export * from "./overview.ts"
export * from "./registry.ts"
export * from "./scalars.ts"
export * from "./tool.ts"
export * from "./version.ts"
export * from "./vocabulary.ts"
