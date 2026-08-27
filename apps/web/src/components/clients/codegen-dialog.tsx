import { generateTypeScriptModule } from "@mokronos/integrations-client/codegen"
import { Code2, Copy } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import * as gateway from "@/lib/gateway"
import {
  useMutation
} from "@/lib/queries"

export function CodegenDialog({ clientId }: { readonly clientId: string }) {
  const [open, setOpen] = useState(false)
  const [module, setModule] = useState<string | undefined>()

  const generate = useMutation({
    mutationFn: async () => {
      const tools = await gateway.listClientTools(clientId, true)
      if (tools.length === 0) throw new Error("Grant at least one tool before generating bindings")
      return generateTypeScriptModule(tools, window.location.origin)
    },
    onSuccess: setModule,
    onError: (error: Error) => toast.error("Could not generate bindings", { description: error.message })
  })

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setModule(undefined) }}>
      <DialogTrigger asChild>
        <Button variant="outline"><Code2 className="size-4" /> Generate bindings</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Generate authorized bindings</DialogTitle>
          <DialogDescription>
            The generated module contains exactly this client’s active grants, including current input and output schemas.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Button onClick={() => generate.mutate()} disabled={generate.isPending}>
            {generate.isPending ? "Generating…" : "Generate"}
          </Button>
        </div>
        {module === undefined ? null : (
          <pre className="bg-muted/60 max-h-[32rem] overflow-auto rounded-lg p-4 font-mono text-xs leading-relaxed">{module}</pre>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={module === undefined}
            onClick={() => {
              void navigator.clipboard.writeText(module ?? "")
              toast.success("Bindings copied")
            }}
          >
            <Copy className="size-4" /> Copy module
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

