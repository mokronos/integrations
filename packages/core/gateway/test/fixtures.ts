import path from "node:path"
import { Crypto, Effect, FileSystem, Scope } from "effect"
import { temporaryDirectory } from "@integrations/contracts/test-fixtures"
import { createGatewayStore } from "../src/index.ts"
import type { GatewayStore } from "../src/index.ts"

export { temporaryDirectory, testServices } from "@integrations/contracts/test-fixtures"

/** A store on its own database, closed when the test's scope ends. */
export const gatewayStore = (
  prefix = "gateway-"
): Effect.Effect<GatewayStore, never, Crypto.Crypto | FileSystem.FileSystem | Scope.Scope> =>
  Effect.flatMap(temporaryDirectory(prefix), openStore)

export const openStore = (
  directory: string
): Effect.Effect<GatewayStore, never, Crypto.Crypto | Scope.Scope> =>
  Effect.acquireRelease(
    Effect.orDie(createGatewayStore(path.join(directory, "gateway.sqlite"))),
    (store) => Effect.orDie(store.close())
  )
