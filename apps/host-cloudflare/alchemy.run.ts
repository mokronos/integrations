import * as Alchemy from "alchemy"
import { AlchemyContext } from "alchemy/AlchemyContext"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"
import GatewayWorkerLive, { GatewayWorker } from "./src/worker.ts"

/** Local development keeps its state on this machine; every deployed stage shares it through Cloudflare. */
const state = Layer.unwrap(
  Effect.map(AlchemyContext, ({ dev }) => dev ? Alchemy.localState() : Cloudflare.state())
)

export default Alchemy.Stack(
  "integrations",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function*() {
    const gateway = yield* GatewayWorker
    return { url: gateway.url }
  }).pipe(Effect.provide(GatewayWorkerLive))
)
