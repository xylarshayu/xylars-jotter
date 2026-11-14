import { svelte } from "@sveltejs/vite-plugin-svelte"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [svelte()],
  build: {
    target: "es2022",
    // No inline scripts or styles: the CSP is script-src 'self'; style-src 'self'.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  // `pnpm dev` in apps/worker serves the API on 8787.
  server: {
    proxy: { "/api": "http://127.0.0.1:8787", "/device-api": "http://127.0.0.1:8787" },
  },
})
