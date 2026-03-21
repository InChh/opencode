import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/log-viewer/app/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/log-viewer/api": "http://localhost:4096",
    },
  },
  build: {
    target: "esnext",
    outDir: "dist",
  },
})
