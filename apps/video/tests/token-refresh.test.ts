import { describe, expect, it, vi, afterEach } from 'vitest'
import { TokenRefreshScheduler } from '../src/rpc/token-refresh.js'

describe('TokenRefreshScheduler', () => {
  let refreshFn: ReturnType<typeof vi.fn> & (() => Promise<number | void>)
  const ttl = 7 * 24 * 3600 * 1000 // 7 days
  let issuedAt: number | undefined
  let expiry: number | undefined

  function setup(elapsedFraction: number) {
    const baseNow = 1000000000000
    issuedAt = baseNow
    expiry = baseNow + ttl
    // Simulate being at `elapsedFraction` of the TTL
    vi.spyOn(Date, 'now').mockReturnValue(baseNow + ttl * elapsedFraction)
    refreshFn = vi.fn().mockResolvedValue(baseNow + ttl * 2)
  }

  function createScheduler(opts?: { refreshThreshold?: number; checkIntervalMs?: number }) {
    return new TokenRefreshScheduler({
      getExpiry: () => expiry,
      getIssuedAt: () => issuedAt,
      refresh: refreshFn,
      refreshThreshold: opts?.refreshThreshold ?? 0.8,
      checkIntervalMs: opts?.checkIntervalMs ?? 100,
    })
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not refresh when token is fresh (at 50% TTL, threshold 80%)', async () => {
    setup(0.5)
    const scheduler = createScheduler()
    const refreshed = await scheduler.check()

    expect(refreshed).toBe(false)
    expect(refreshFn).not.toHaveBeenCalled()
  })

  it('refreshes when token reaches 80% of TTL', async () => {
    setup(0.9) // 90% elapsed, past 80% threshold
    const scheduler = createScheduler()
    const refreshed = await scheduler.check()

    expect(refreshed).toBe(true)
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('refreshes exactly at threshold boundary', async () => {
    setup(0.8) // exactly at 80%
    const scheduler = createScheduler()
    const refreshed = await scheduler.check()

    expect(refreshed).toBe(true)
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('does not refresh when expiry is undefined', async () => {
    setup(0.9)
    expiry = undefined
    const scheduler = createScheduler()
    const refreshed = await scheduler.check()

    expect(refreshed).toBe(false)
    expect(refreshFn).not.toHaveBeenCalled()
  })

  it('does not refresh when issuedAt is undefined', async () => {
    setup(0.9)
    issuedAt = undefined
    const scheduler = createScheduler()
    const refreshed = await scheduler.check()

    expect(refreshed).toBe(false)
    expect(refreshFn).not.toHaveBeenCalled()
  })

  it('refreshes when token is expired', async () => {
    setup(1.1) // past expiry
    const scheduler = createScheduler()
    const refreshed = await scheduler.check()

    expect(refreshed).toBe(true)
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('starts periodic checks', async () => {
    vi.restoreAllMocks()
    refreshFn = vi.fn().mockResolvedValue(Date.now() + ttl)
    // Token already needs refresh
    const now = Date.now()
    issuedAt = now - ttl
    expiry = now

    const scheduler = createScheduler({ checkIntervalMs: 50 })
    scheduler.start()
    await new Promise((r) => setTimeout(r, 130))
    scheduler.stop()

    expect(refreshFn.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('stops periodic checks', async () => {
    vi.restoreAllMocks()
    refreshFn = vi.fn().mockResolvedValue(Date.now() + ttl)
    const now = Date.now()
    issuedAt = now - ttl
    expiry = now

    const scheduler = createScheduler({ checkIntervalMs: 50 })
    scheduler.start()
    scheduler.stop()

    await new Promise((r) => setTimeout(r, 100))
    expect(refreshFn).not.toHaveBeenCalled()
  })

  it('is idempotent on start', () => {
    setup(0.5)
    const scheduler = createScheduler({ checkIntervalMs: 100 })
    scheduler.start()
    scheduler.start()
    scheduler.stop()
  })

  it('uses configurable threshold', async () => {
    // At 60% of TTL
    setup(0.6)

    // 50% threshold → should refresh (60% > 50%)
    const scheduler50 = createScheduler({ refreshThreshold: 0.5 })
    const refreshed50 = await scheduler50.check()
    expect(refreshed50).toBe(true)

    refreshFn.mockClear()

    // 80% threshold → should NOT refresh (60% < 80%)
    const scheduler80 = createScheduler({ refreshThreshold: 0.8 })
    const refreshed80 = await scheduler80.check()
    expect(refreshed80).toBe(false)
  })
})
