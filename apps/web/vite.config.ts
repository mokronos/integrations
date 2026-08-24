import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { defineConfig } from "vite"

/** The control plane is served by the gateway itself in every real use — same
 * origin, so the browser's own request is what authenticates it.
 *
 * A dev server breaks that: the page is on 5173 and the gateway is on 4788.
 * The proxy below stitches the origin back together, which is why the rewritten
 * `origin` header is here and not something the gateway relaxes for everyone.
 */
const gatewayTarget = process.env["INTEGRATIONS_URL"] ?? "http://127.0.0.1:4788"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src")
    }
  },
  server: {
    proxy: {
      "/v1": {
        target: gatewayTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyRequest) => {
            // Without this the gateway sees the dev server's origin, refuses to
            // treat the request as its own page, and every call is a 401.
            proxyRequest.setHeader("origin", gatewayTarget)
          })
        }
      }
    },
    fs: {
      allow: [path.resolve(import.meta.dirname, "../../..")]
    }
  }
})
