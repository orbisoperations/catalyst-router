import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TickManager } from '../../src/v2/tick-manager.js'
import { Actions } from '@catalyst/routing/v2'

describe('TickManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('dispatches Tick actions on interval', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch, intervalMs: 1000 })
    tm.start()

    vi.advanceTimersByTime(3000)
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect(dispatch.mock.calls[0][0].action).toBe(Actions.Tick)
    tm.stop()
  })

  it('Tick payload includes a numeric now timestamp', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch, intervalMs: 1000 })
    tm.start()

    vi.advanceTimersByTime(1000)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const payload = dispatch.mock.calls[0][0]
    expect(payload.action).toBe(Actions.Tick)
    expect(typeof payload.data.now).toBe('number')
    tm.stop()
  })

  it('stop() ceases dispatch', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch, intervalMs: 1000 })
    tm.start()

    vi.advanceTimersByTime(2000)
    tm.stop()
    vi.advanceTimersByTime(5000)

    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('recalculate() adjusts interval to minHoldTime / 3', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch, intervalMs: 30_000 })
    tm.start()

    tm.recalculate([9000]) // 9000 / 3 = 3000
    expect(tm.currentIntervalMs).toBe(3000)
    tm.stop()
  })

  it('recalculate() picks minimum across multiple holdTimes', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch, intervalMs: 30_000 })

    tm.recalculate([90_000, 30_000, 9000]) // min is 9000, /3 = 3000
    expect(tm.currentIntervalMs).toBe(3000)
  })

  it('recalculate() enforces minimum interval of 1000ms', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch, intervalMs: 30_000 })

    tm.recalculate([600]) // 600 / 3 = 200 → clamped to 1000
    expect(tm.currentIntervalMs).toBe(1000)
  })

  it('recalculate() ignores holdTime 0', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch, intervalMs: 30_000 })

    tm.recalculate([0, 0])
    expect(tm.currentIntervalMs).toBe(30_000) // unchanged
  })

  it('recalculate() with empty array is a no-op', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch, intervalMs: 30_000 })

    tm.recalculate([])
    expect(tm.currentIntervalMs).toBe(30_000)
  })

  it('recalculate() restarts the timer when running and interval changes', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch, intervalMs: 30_000 })
    tm.start()

    // Fire one tick at 30s
    vi.advanceTimersByTime(30_000)
    expect(dispatch).toHaveBeenCalledTimes(1)

    // Recalculate to 3s — timer restarts
    tm.recalculate([9000])
    dispatch.mockClear()

    vi.advanceTimersByTime(6000)
    expect(dispatch).toHaveBeenCalledTimes(2) // 2 ticks at 3s interval
    tm.stop()
  })

  it('recalculate() does not restart the timer when interval is unchanged', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch, intervalMs: 3000 })
    tm.start()

    // Same interval → no restart, timer continues from where it is
    tm.recalculate([9000]) // 9000 / 3 = 3000 — same as current
    expect(tm.currentIntervalMs).toBe(3000)
    expect(tm.isRunning).toBe(true)

    vi.advanceTimersByTime(3000)
    expect(dispatch).toHaveBeenCalledTimes(1)
    tm.stop()
  })

  it('isRunning reflects state', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch })

    expect(tm.isRunning).toBe(false)
    tm.start()
    expect(tm.isRunning).toBe(true)
    tm.stop()
    expect(tm.isRunning).toBe(false)
  })

  it('start() is idempotent — calling twice does not double-fire', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch, intervalMs: 1000 })

    tm.start()
    tm.start() // second call must be a no-op

    vi.advanceTimersByTime(1000)
    expect(dispatch).toHaveBeenCalledTimes(1)
    tm.stop()
  })

  it('stop() is idempotent when not running', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch })

    expect(() => tm.stop()).not.toThrow()
    expect(tm.isRunning).toBe(false)
  })

  it('dispatch rejections are swallowed (fire-and-forget)', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('dispatch failed'))
    const tm = new TickManager({ dispatchFn: dispatch, intervalMs: 1000 })
    tm.start()

    // Should not throw
    await expect(
      new Promise<void>((resolve) => {
        vi.advanceTimersByTime(1000)
        // Give microtasks time to settle
        Promise.resolve().then(resolve)
      })
    ).resolves.toBeUndefined()

    tm.stop()
  })

  it('uses 30s default interval when none specified', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const tm = new TickManager({ dispatchFn: dispatch })

    expect(tm.currentIntervalMs).toBe(30_000)
  })
})
