export const cliInstallCommand =
  "curl -fsSL https://raw.githubusercontent.com/mokronos/integrations/main/install.sh | sh"

export const skillInstallCommand =
  "npx skills add https://github.com/mokronos/integrations/tree/main/.agents/skills/integrations -g"

export const cliConfiguration = (gatewayUrl: string, apiKey: string): string =>
  `export INTEGRATIONS_URL=${JSON.stringify(gatewayUrl)}\nexport INTEGRATIONS_API_KEY=${JSON.stringify(apiKey)}\ni integrations`

export const tsClientInstallCommand = "bun add @integragents/client"

export const tsClientExample = (gatewayUrl: string, apiKey: string): string =>
  `import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { makeGatewayClient } from "@integragents/client/client"

const program = Effect.gen(function*() {
  const gateway = yield* makeGatewayClient({ url: ${JSON.stringify(gatewayUrl)}, apiKey: ${JSON.stringify(apiKey)} })
  const { tools } = yield* gateway.delegated.listTools({ query: { schemas: false } })
  console.log(tools)
})

Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)))`
