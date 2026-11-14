/**
 * Auto-lock: clears unlocked channel keys after a period without input, and
 * when the page has been hidden longer than a grace period. Uses wall-clock
 * checks so a device that slept still locks on wake.
 */
export interface AutoLockOptions {
  idleMs(): number
  hideGraceMs(): number
  hasUnlocked(): boolean
  lock(reason: "idle" | "hidden"): void
  doc?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">
  win?: Pick<Window, "addEventListener" | "removeEventListener">
  now?: () => number
  checkEveryMs?: number
}

const ACTIVITY = ["pointerdown", "keydown", "wheel", "touchstart"] as const

export function startAutoLock(o: AutoLockOptions): { stop(): void; touch(): void } {
  const doc = o.doc ?? document
  const win = o.win ?? window
  const now = o.now ?? Date.now
  let last = now()
  let hiddenAt: number | null = null
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  const touch = () => {
    last = now()
  }
  const check = () => {
    if (!o.hasUnlocked()) return
    if (hiddenAt !== null && now() - hiddenAt >= o.hideGraceMs()) o.lock("hidden")
    else if (now() - last >= o.idleMs()) o.lock("idle")
  }
  const onVisibility = () => {
    clearTimeout(hideTimer)
    if (doc.visibilityState === "hidden") {
      hiddenAt = now()
      if (!o.hasUnlocked()) return
      const grace = o.hideGraceMs()
      if (grace <= 0) o.lock("hidden")
      else hideTimer = setTimeout(check, grace)
    } else {
      check()
      hiddenAt = null
      touch()
    }
  }
  const onPageHide = () => {
    if (o.hasUnlocked()) o.lock("hidden")
  }

  for (const t of ACTIVITY) win.addEventListener(t, touch, { capture: true, passive: true })
  doc.addEventListener("visibilitychange", onVisibility)
  win.addEventListener("pagehide", onPageHide)
  const interval = setInterval(check, o.checkEveryMs ?? 5000)

  return {
    touch,
    stop() {
      clearInterval(interval)
      clearTimeout(hideTimer)
      for (const t of ACTIVITY) win.removeEventListener(t, touch, { capture: true })
      doc.removeEventListener("visibilitychange", onVisibility)
      win.removeEventListener("pagehide", onPageHide)
    },
  }
}
