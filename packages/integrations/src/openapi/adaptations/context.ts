import type { CompiledSecurityScheme } from "../compile.ts"

export interface AdaptationContext {
  readonly servers: ReadonlyArray<string>
  readonly securitySchemes: ReadonlyArray<CompiledSecurityScheme>
}
