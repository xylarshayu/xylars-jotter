/** Device preferences. Not secret; kept in localStorage. */
export type Theme = "system" | "light" | "dark"
export type EnterMode = "auto" | "on" | "off"

export interface Settings {
  theme: Theme
  /** auto: Enter sends with a physical keyboard, adds a newline on touch screens. */
  enterSends: EnterMode
  idleMinutes: number
  hideGraceSeconds: number
}

export const DEFAULTS: Settings = {
  theme: "system",
  enterSends: "auto",
  idleMinutes: 5,
  hideGraceSeconds: 30,
}

export const IDLE_CHOICES = [1, 5, 15, 30]
export const HIDE_CHOICES = [0, 30, 120]

const KEY = "jot.settings"

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>
    return {
      theme: ["system", "light", "dark"].includes(raw.theme as string)
        ? raw.theme!
        : DEFAULTS.theme,
      enterSends: ["auto", "on", "off"].includes(raw.enterSends as string)
        ? raw.enterSends!
        : DEFAULTS.enterSends,
      idleMinutes: IDLE_CHOICES.includes(raw.idleMinutes!)
        ? raw.idleMinutes!
        : DEFAULTS.idleMinutes,
      hideGraceSeconds: HIDE_CHOICES.includes(raw.hideGraceSeconds!)
        ? raw.hideGraceSeconds!
        : DEFAULTS.hideGraceSeconds,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* private mode: settings last for this session */
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === "system") delete root.dataset.theme
  else root.dataset.theme = theme
}
