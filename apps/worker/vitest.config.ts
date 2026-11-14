import { mkdirSync } from "node:fs"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

// The assets directory must exist for the Worker config to load in tests.
mkdirSync(new URL("../web/dist", import.meta.url), { recursive: true })

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname)
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, AUTH_MODE: "dev" } },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"], testTimeout: 30_000 },
  }
})
