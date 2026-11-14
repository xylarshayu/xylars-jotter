import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestProject } from "vitest/node"

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number }
      s.close(() => res(port))
    })
  })
}

const children: ChildProcess[] = []
const dirs: string[] = []

/** Starts a local Worker on a free port with its own temporary D1/R2 state. */
async function server(): Promise<string> {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), "jot-cli-test-"))
  dirs.push(dir)
  const script = join(import.meta.dirname, "..", "..", "worker", "scripts", "local-server.mjs")
  children.push(
    spawn(process.execPath, [script, String(port), dir], { stdio: "ignore", detached: true }),
  )
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 90_000
  for (;;) {
    try {
      const r = await fetch(`${url}/api/me`)
      if (r.ok) return url
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("local worker did not start")
    await new Promise((r) => setTimeout(r, 300))
  }
}

export async function setup(project: TestProject) {
  // The second server is an empty "deployment" for `jot migrate`.
  const [main, target] = await Promise.all([server(), server()])
  project.provide("serverUrl", main)
  project.provide("targetUrl", target)
}

export async function teardown() {
  for (const child of children) {
    if (!child.pid) continue
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      /* already gone */
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

declare module "vitest" {
  export interface ProvidedContext {
    serverUrl: string
    targetUrl: string
  }
}
