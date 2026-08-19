import { useMemo, useState } from "react"
import { Braces, CheckCircle2, Play, TriangleAlert, XCircle } from "lucide-react"
import { Schema } from "effect"
import { toast } from "sonner"

import { JsonView } from "@/components/json-view"
import { Page } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import * as gateway from "@/lib/gateway"
import { useIntegrations, useMutation } from "@/lib/queries"
import type { IntegrationValidationReport } from "@mokronos/wfkit-executor/integration-model"

const JsonText = Schema.fromJsonString(Schema.Json)
const decodeJsonText = Schema.decodeUnknownSync(JsonText)

const editorClass =
  "border-input bg-muted/30 focus-visible:border-ring focus-visible:ring-ring/50 min-h-40 w-full resize-y rounded-lg border px-3 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-[3px]"

const findingVariant = {
  info: "secondary",
  warning: "outline",
  error: "destructive"
} satisfies Readonly<Record<"info" | "warning" | "error", "secondary" | "outline" | "destructive">>

function ValidationPanel() {
  const [source, setSource] = useState(
    JSON.stringify({ source: { kind: "executor", address: "tools.integration.org.default.tool" } }, null, 2)
  )
  const [live, setLive] = useState(true)
  const [report, setReport] = useState<IntegrationValidationReport | undefined>()

  const validate = useMutation({
    mutationFn: () => gateway.validateNode({ node: decodeJsonText(source), live }),
    onSuccess: setReport,
    onError: (error: Error) => toast.error("Validation failed", { description: error.message })
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Braces className="size-4" /> Validate a workflow node</CardTitle>
        <CardDescription>
          Check an executor address, an integration/tool reference, or a gateway alias. Live validation also verifies that it resolves now.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="validation-source">Node JSON</Label>
          <textarea
            id="validation-source"
            className={editorClass}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch id="live-validation" checked={live} onCheckedChange={setLive} />
            <Label htmlFor="live-validation">Check live reachability</Label>
          </div>
          <Button className="ml-auto" onClick={() => validate.mutate()} disabled={validate.isPending}>
            {validate.isPending ? "Checking…" : "Validate"}
          </Button>
        </div>
        {report === undefined ? null : (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center gap-2 font-medium">
              {report.ok
                ? <CheckCircle2 className="size-4 text-emerald-500" />
                : <XCircle className="text-destructive size-4" />}
              {report.ok ? "Valid" : "Needs attention"}
            </div>
            {report.findings.map((finding, index) => (
              <div key={`${finding.check}-${index}`} className="flex items-start gap-2 text-sm">
                <Badge variant={findingVariant[finding.severity]}>{finding.check}</Badge>
                <span className="text-muted-foreground">{finding.message}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function InvocationPanel() {
  const integrations = useIntegrations()
  const tools = useMemo(
    () => (integrations.data ?? []).flatMap((integration) => integration.tools),
    [integrations.data]
  )
  const [address, setAddress] = useState("")
  const [argumentsText, setArgumentsText] = useState("{}")
  const [result, setResult] = useState<typeof Schema.Json.Type | undefined>()

  const invoke = useMutation({
    mutationFn: () => gateway.invokeTool({
      address,
      arguments: decodeJsonText(argumentsText)
    }),
    onSuccess: (value) => {
      setResult(value)
      toast.success("Tool completed")
    },
    onError: (error: Error) => toast.error("Tool failed", { description: error.message })
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Play className="size-4" /> Test a connected tool</CardTitle>
        <CardDescription>
          Invoke a concrete tool address with the control plane’s authority. This tests the connection directly; client grants are not involved.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label>Tool address</Label>
          <Select value={address} onValueChange={setAddress}>
            <SelectTrigger><SelectValue placeholder="Choose a connected tool" /></SelectTrigger>
            <SelectContent>
              {tools.map((tool) => (
                <SelectItem key={tool.address} value={tool.address}>
                  {tool.integration} / {tool.connection} / {tool.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invocation-arguments">Arguments JSON</Label>
          <textarea
            id="invocation-arguments"
            className={editorClass}
            value={argumentsText}
            onChange={(event) => setArgumentsText(event.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-amber-500" />
          <p className="text-muted-foreground text-xs">This performs the real operation. Use non-destructive inputs when exploring.</p>
          <Button className="ml-auto" onClick={() => invoke.mutate()} disabled={address.length === 0 || invoke.isPending}>
            <Play className="size-3" /> {invoke.isPending ? "Running…" : "Run"}
          </Button>
        </div>
        {result === undefined ? null : <JsonView value={result} label="result" />}
      </CardContent>
    </Card>
  )
}

export function WorkbenchRoute() {
  return (
    <Page
      title="Workbench"
      description="Validate workflow integration nodes and test connected tools before putting them in a run."
    >
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <ValidationPanel />
        <InvocationPanel />
      </div>
    </Page>
  )
}
