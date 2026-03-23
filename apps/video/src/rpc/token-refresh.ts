/**
 * Token refresh scheduler.
 *
 * Hourly check, refresh at 80% TTL (~5.6 days for a 7-day token).
 * Follows the orchestrator's existing pattern at catalyst-service.ts:268-288.
 * All components use refreshed credentials transparently — the scheduler
 * swaps the token value in place.
 */

export interface TokenRefreshOptions {
  /** Function to get the current token's expiry time (ms since epoch). */
  getExpiry: () => number | undefined
  /** Function to get the token's issued-at time (ms since epoch). */
  getIssuedAt: () => number | undefined
  /** Function to refresh credentials. May return the new expiry or void. */
  refresh: () => Promise<number | void>
  /** TTL fraction at which to trigger refresh (default: 0.8 = 80%). */
  refreshThreshold?: number
  /** Check interval in ms (default: 3600000 = 1 hour). */
  checkIntervalMs?: number
}

export class TokenRefreshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly getExpiry: () => number | undefined
  private readonly getIssuedAt: () => number | undefined
  private readonly refresh: () => Promise<number | void>
  private readonly refreshThreshold: number
  private readonly checkIntervalMs: number

  constructor(options: TokenRefreshOptions) {
    this.getExpiry = options.getExpiry
    this.getIssuedAt = options.getIssuedAt
    this.refresh = options.refresh
    this.refreshThreshold = options.refreshThreshold ?? 0.8
    this.checkIntervalMs = options.checkIntervalMs ?? 3_600_000
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.check(), this.checkIntervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Check if the token needs refresh and do so if necessary.
   *
   * Refresh triggers when elapsed time exceeds `threshold * totalTTL`.
   * For a 7-day token with 0.8 threshold, refresh triggers at ~5.6 days.
   */
  async check(): Promise<boolean> {
    const expiry = this.getExpiry()
    const issuedAt = this.getIssuedAt()
    if (expiry === undefined || issuedAt === undefined) return false

    const now = Date.now()
    const totalTtl = expiry - issuedAt
    const elapsed = now - issuedAt

    if (elapsed >= totalTtl * this.refreshThreshold) {
      await this.refresh()
      return true
    }

    return false
  }
}
