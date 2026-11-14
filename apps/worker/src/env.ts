export interface Env {
  DB: D1Database
  FILES: R2Bucket
  ASSETS: Fetcher
  /** "dev" accepts unauthenticated requests on localhost only. Never set in production. */
  AUTH_MODE?: string
  /** e.g. "https://myteam.cloudflareaccess.com" */
  ACCESS_TEAM_DOMAIN?: string
  /** Access application audience tag. */
  ACCESS_AUD?: string
  OWNER_EMAIL?: string
  /** Client ID of the Access service token used by the CLI. */
  SERVICE_TOKEN_CLIENT_ID?: string
  OWNER_USER_ID?: string
}

/** The paired device a request came from; null when it came through Access (ADR-0019). */
export interface DeviceSession {
  id: string
  temporary: boolean
}

export type AppEnv = {
  Bindings: Env
  Variables: { userId: string; device: DeviceSession | null }
}
