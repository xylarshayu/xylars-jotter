import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startAutoLock } from "../src/lib/autolock.ts"

function setup(opts: { unlocked?: boolean; grace?: number } = {}) {
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  })
  const win = new EventTarget()
  const locks: string[] = []
  let unlocked = opts.unlocked ?? true
  const al = startAutoLock({
    idleMs: () => 5 * 60_000,
    hideGraceMs: () => opts.grace ?? 30_000,
    hasUnlocked: () => unlocked,
    lock: (r) => {
      locks.push(r)
      unlocked = false
    },
    doc: doc as unknown as Document,
    win: win as unknown as Window,
    checkEveryMs: 1000,
  })
  const hide = (state: DocumentVisibilityState) => {
    doc.visibilityState = state
    doc.dispatchEvent(new Event("visibilitychange"))
  }
  return { al, locks, win, hide, setUnlocked: (v: boolean) => (unlocked = v) }
}

describe("auto-lock", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("locks after the idle timeout, and activity postpones it", () => {
    const { locks, win, al } = setup()
    vi.advanceTimersByTime(4 * 60_000)
    win.dispatchEvent(new Event("pointerdown"))
    vi.advanceTimersByTime(4 * 60_000)
    expect(locks).toEqual([])
    vi.advanceTimersByTime(61_000)
    expect(locks).toEqual(["idle"])
    al.stop()
  })

  it("locks when hidden past the grace period, not before", () => {
    const { locks, hide, al } = setup()
    hide("hidden")
    vi.advanceTimersByTime(20_000)
    hide("visible")
    expect(locks).toEqual([])
    hide("hidden")
    vi.advanceTimersByTime(30_000)
    expect(locks).toEqual(["hidden"])
    al.stop()
  })

  it("locks on wake if the device slept while hidden", () => {
    const { locks, hide, al } = setup()
    hide("hidden")
    vi.setSystemTime(Date.now() + 10 * 60_000) // timers didn't run while asleep
    hide("visible")
    expect(locks).toEqual(["hidden"])
    al.stop()
  })

  it("locks immediately with a zero grace period and on pagehide", () => {
    const a = setup({ grace: 0 })
    a.hide("hidden")
    expect(a.locks).toEqual(["hidden"])
    a.al.stop()
    const b = setup()
    b.win.dispatchEvent(new Event("pagehide"))
    expect(b.locks).toEqual(["hidden"])
    b.al.stop()
  })

  it("does nothing while nothing is unlocked", () => {
    const { locks, al } = setup({ unlocked: false })
    vi.advanceTimersByTime(60 * 60_000)
    expect(locks).toEqual([])
    al.stop()
  })
})
