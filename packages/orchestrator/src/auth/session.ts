import type { AuthContext } from '../plugins/types.js'

export interface SessionOptions {
  auth: AuthContext
  /** Token expiry time (from JWT exp claim). If not set, session never expires. */
  expiresAt?: Date
}

/**
 * Session holds authenticated user context for a WebSocket connection.
 * Created once at connection time, used for all actions on that connection.
 *
 * Sessions track token expiry to handle long-lived WebSocket connections.
 * When a token expires, subsequent actions are rejected and the client
 * must reconnect with a fresh token.
 */
export class Session {
  readonly auth: AuthContext
  readonly connectionId: string
  readonly connectedAt: Date
  readonly expiresAt: Date | null

  constructor(options: SessionOptions) {
    this.auth = options.auth
    this.expiresAt = options.expiresAt ?? null
    this.connectionId = crypto.randomUUID()
    this.connectedAt = new Date()
  }

  /**
   * Check if the session's token has expired.
   * Sessions without an expiry time never expire.
   * Note: A token is considered expired at exactly its expiry time (>=).
   */
  isExpired(): boolean {
    if (!this.expiresAt) {
      return false
    }
    return Date.now() >= this.expiresAt.getTime()
  }

  /**
   * Get remaining time until session expires in milliseconds.
   * Returns null if session has no expiry, 0 if already expired.
   */
  remainingMs(): number | null {
    if (!this.expiresAt) {
      return null
    }
    const remaining = this.expiresAt.getTime() - Date.now()
    return Math.max(0, remaining)
  }
}
