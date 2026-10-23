import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { isGatewayError } from "@integragents/contracts"
import { BrowserRouter } from "react-router"

import App from "@/App"
import { keys } from "@/lib/queries"
import { TooltipProvider } from "@/components/ui/tooltip"

import "@/index.css"

/** A call the gateway refused for want of a session sends the dashboard back to sign-in. */
const signInAgainOn = (error: Error): void => {
  if (isGatewayError(error) && error._tag === "Unauthorized") void queryClient.invalidateQueries({ queryKey: keys.me })
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: signInAgainOn }),
  mutationCache: new MutationCache({ onError: signInAgainOn }),
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: false,
      refetchOnWindowFocus: true
    }
  }
})

const container = document.getElementById("root")
if (container === null) throw new Error("index.html is missing its #root element")

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
)
