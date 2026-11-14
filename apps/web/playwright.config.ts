import { defineConfig, devices } from "@playwright/test"

// End-to-end tests against the real Worker (wrangler dev, local D1/R2, AUTH_MODE=dev)
// serving the production build. No Cloudflare login needed. Run: pnpm --filter @jot/web e2e
const PORT = 8799

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    serviceWorkers: "allow",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm build && node ../worker/scripts/local-server.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
})
