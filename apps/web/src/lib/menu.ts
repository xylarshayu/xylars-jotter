import { app, type MenuItem } from "./app.svelte.ts"

const HOLD_MS = 450
const SLOP_PX = 10

/**
 * Opens a menu of `items()` on a right click, the keyboard's menu key, or a long press on a
 * touch screen. A link inside the element, or text selected in it, keeps the browser's own menu.
 */
export function contextMenu(node: HTMLElement, items: () => MenuItem[]) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let start: { x: number; y: number } | null = null
  let heldAt = 0

  const open = (x: number, y: number) => {
    const list = items()
    if (list.length) app.menu = { x, y, items: list }
  }

  function native(target: EventTarget | null): boolean {
    const el = target instanceof Element ? target : null
    const link = el?.closest("a[href], input, textarea")
    if (link && link !== node) return true
    const sel = getSelection()
    return !!sel && !sel.isCollapsed && node.contains(sel.anchorNode)
  }

  function oncontextmenu(e: MouseEvent) {
    // A long press already opened it; Android follows up with contextmenu as well.
    if (Date.now() - heldAt < 1000) return e.preventDefault()
    if (native(e.target)) return
    e.preventDefault()
    // Android's own long press can come first: treat it as the press, so lifting taps nothing.
    if (start) {
      cancel()
      heldAt = Date.now()
    }
    if (e.clientX || e.clientY) open(e.clientX, e.clientY)
    else {
      const r = node.getBoundingClientRect()
      open(r.left + 16, r.top + 16)
    }
  }

  // iOS fires no contextmenu for touch, so a long press is timed here.
  function cancel() {
    clearTimeout(timer)
    timer = undefined
    start = null
  }
  function ontouchstart(e: TouchEvent) {
    const t = e.touches[0]
    if (e.touches.length !== 1 || !t || native(e.target)) return cancel()
    start = { x: t.clientX, y: t.clientY }
    timer = setTimeout(() => {
      if (!start) return
      heldAt = Date.now()
      getSelection()?.removeAllRanges()
      open(start.x, start.y)
      cancel()
    }, HOLD_MS)
  }
  function ontouchmove(e: TouchEvent) {
    const t = e.touches[0]
    if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > SLOP_PX) cancel()
  }
  function ontouchend(e: TouchEvent) {
    cancel()
    // The press opened the menu: don't let the lift also tap what was under the finger.
    if (Date.now() - heldAt < 1000) e.preventDefault()
  }

  node.addEventListener("contextmenu", oncontextmenu)
  node.addEventListener("touchstart", ontouchstart, { passive: true })
  node.addEventListener("touchmove", ontouchmove, { passive: true })
  node.addEventListener("touchend", ontouchend)
  node.addEventListener("touchcancel", cancel)
  return {
    destroy() {
      cancel()
      node.removeEventListener("contextmenu", oncontextmenu)
      node.removeEventListener("touchstart", ontouchstart)
      node.removeEventListener("touchmove", ontouchmove)
      node.removeEventListener("touchend", ontouchend)
      node.removeEventListener("touchcancel", cancel)
    },
  }
}
