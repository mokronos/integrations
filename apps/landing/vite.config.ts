import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Project pages serve from /<repo>/, so the build must use that base.
export default defineConfig({
  base: "/integrations/",
  plugins: [react(), tailwindcss()]
})
