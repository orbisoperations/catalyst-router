import { Actions } from '@catalyst/routing/v2'
import type { Action } from '@catalyst/routing/v2'

/**
 * Manages periodic Tick dispatch and keepalive lifecycle.
 * Fires Tick actions at a configurable interval to drive hold timer checks.
 */
export class TickManager {
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly dispatchFn: (action: Action) => Promise<unknown>
  private intervalMs: number

  constructor(opts: { dispatchFn: (action: Action) => Promise<unknown>; intervalMs?: number }) {
    this.dispatchFn = opts.dispatchFn
    this.intervalMs = opts.intervalMs ?? 30_000
  }

  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      this.dispatchFn({
        action: Actions.Tick,
        data: { now: Date.now() },
      }).catch(() => {}) // fire-and-forget
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Recalculate tick interval based on min holdTime / 3 across peers.
   * Restarts the timer if it is currently running and the interval changed.
   */
  recalculate(holdTimes: number[]): void {
    const active = holdTimes.filter((h) => h > 0)
    if (active.length === 0) return

    const minHold = Math.min(...active)
    const newInterval = Math.max(1000, Math.floor(minHold / 3))

    if (newInterval !== this.intervalMs) {
      this.intervalMs = newInterval
      if (this.timer !== undefined) {
        this.stop()
        this.start()
      }
    }
  }

  get currentIntervalMs(): number {
    return this.intervalMs
  }

  get isRunning(): boolean {
    return this.timer !== undefined
  }
}
