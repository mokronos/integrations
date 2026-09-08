import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { defineConfig } from "vite"

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
