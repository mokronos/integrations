import { createGatewayClient } from "@mokronos/integrations-client"
import { Schema } from "effect"

const decodeArguments = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Json)
)

const [alias, tool, argumentsText = "{}"] = process.argv.slice(2)
if (alias === undefined || tool === undefined) {
  console.error("Usage: bun client-demo.ts <alias> <tool> [json-arguments]")
  process.exit(2)
}

const url = process.env["INTEGRATIONS_URL"]
const apiKey = process.env["INTEGRATIONS_API_KEY"]
if (url === undefined || apiKey === undefined) {
  throw new Error("The sandbox did not provide its broker connection")
}

const gateway = createGatewayClient({ url, apiKey })
const outcome = await gateway.execute({
  alias,
  tool,
  arguments: decodeArguments(argumentsText)
})

console.log(JSON.stringify(outcome, null, 2))
