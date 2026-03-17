import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AdapterHealthChecker } from '../../src/v2/adapter-health.js'
import type { DataChannelDefinition } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoute(name: string, opts: Partial<DataChannelDefinition> = {}): DataChannelDefinition {
  return {
    name,
    protocol: 'http',
    endpoint: `http://${name}:8080`,
    ...opts,
  }
}

function makeMockResponse(status: number, ok: boolean = status >= 200 && status < 300): Response {
  return { status, ok } as Response
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterHealthChecker', () => {
  let checker: AdapterHealthChecker

  beforeEach(() => {
    vi.useFakeTimers()
    checker = new AdapterHealthChecker({ intervalMs: 5000, timeoutMs: 2000 })
  })

  afterEach(() => {
    checker.stop()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // 1. /health returns 200 → status 'up', responseTimeMs recorded
  // -------------------------------------------------------------------------
  it('adapter with /health returning 200 → status up, responseTimeMs recorded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(200)))

    const routes = [makeRoute('alpha')]
    await checker.checkAll(routes)

    const health = checker.getHealth('alpha')
    expect(health).toBeDefined()
    expect(health?.healthStatus).toBe('up')
    expect(health?.responseTimeMs).toBeTypeOf('number')
    expect(health?.responseTimeMs).toBeGreaterThanOrEqual(0)
    expect(health?.lastChecked).toBeTypeOf('string')
  })

  // -------------------------------------------------------------------------
  // 2. /health returns 404 → status 'unknown', not re-checked on future cycles
  // -------------------------------------------------------------------------
  it('adapter with /health returning 404 → status unknown, skipped on subsequent cycles', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeMockResponse(404, false))
    vi.stubGlobal('fetch', mockFetch)

    const routes = [makeRoute('beta')]

    // First cycle
    await checker.checkAll(routes)

    expect(checker.getHealth('beta')?.healthStatus).toBe('unknown')
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Second cycle — should NOT call fetch again
    await checker.checkAll(routes)

    expect(mockFetch).toHaveBeenCalledTimes(1) // still 1, not re-checked
  })

  // -------------------------------------------------------------------------
  // 2b. /health was up then returns 404 → status 'down', still re-checked
  // -------------------------------------------------------------------------
  it('adapter previously up then 404 → status down, still re-checked', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeMockResponse(200)) // first: up
      .mockResolvedValueOnce(makeMockResponse(404, false)) // second: 404
      .mockResolvedValueOnce(makeMockResponse(404, false)) // third: still 404

    vi.stubGlobal('fetch', mockFetch)

    const routes = [makeRoute('beta')]

    await checker.checkAll(routes)
    expect(checker.getHealth('beta')?.healthStatus).toBe('up')

    await checker.checkAll(routes)
    expect(checker.getHealth('beta')?.healthStatus).toBe('down')

    // Should NOT be suppressed — still re-checked on next cycle
    await checker.checkAll(routes)
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  // -------------------------------------------------------------------------
  // 3. Adapter previously 'up' then fails → status 'down'
  // -------------------------------------------------------------------------
  it('adapter previously up then fails → status down', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeMockResponse(200)) // first call: success
      .mockRejectedValueOnce(new Error('connection refused')) // second call: failure

    vi.stubGlobal('fetch', mockFetch)

    const routes = [makeRoute('gamma')]

    // First cycle: up
    await checker.checkAll(routes)
    expect(checker.getHealth('gamma')?.healthStatus).toBe('up')

    // Second cycle: network failure
    await checker.checkAll(routes)
    expect(checker.getHealth('gamma')?.healthStatus).toBe('down')
  })

  // -------------------------------------------------------------------------
  // 4. Non-HTTP protocol → 'unknown', no fetch made
  // -------------------------------------------------------------------------
  it('non-HTTP protocol → unknown, no fetch made', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    const routes = [makeRoute('tcp-svc', { protocol: 'tcp', endpoint: 'tcp://tcp-svc:9000' })]
    await checker.checkAll(routes)

    expect(checker.getHealth('tcp-svc')?.healthStatus).toBe('unknown')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 5. Health URL construction: strips path, replaces with /health
  // -------------------------------------------------------------------------
  it('constructs health URL by replacing path with /health', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeMockResponse(200))
    vi.stubGlobal('fetch', mockFetch)

    const routes = [makeRoute('svc', { endpoint: 'http://svc:8080/api/v1/data' })]
    await checker.checkAll(routes)

    expect(mockFetch).toHaveBeenCalledOnce()
    const calledUrl: string = mockFetch.mock.calls[0][0]
    expect(calledUrl).toBe('http://svc:8080/health')
  })

  // -------------------------------------------------------------------------
  // 6. Missing endpoint → 'unknown', no fetch made
  // -------------------------------------------------------------------------
  it('missing endpoint → unknown, no fetch made', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    const routes = [makeRoute('no-ep', { endpoint: undefined })]
    await checker.checkAll(routes)

    expect(checker.getHealth('no-ep')?.healthStatus).toBe('unknown')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 7. Route removed → health entry cleared
  // -------------------------------------------------------------------------
  it('route removed between cycles → health entry cleared', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(200)))

    const routes = [makeRoute('alpha'), makeRoute('beta')]

    // First cycle: both routes present
    await checker.checkAll(routes)
    expect(checker.getHealth('alpha')).toBeDefined()
    expect(checker.getHealth('beta')).toBeDefined()

    // Second cycle: 'beta' removed
    await checker.checkAll([makeRoute('alpha')])
    expect(checker.getHealth('alpha')).toBeDefined()
    expect(checker.getHealth('beta')).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // 8. Checks run in parallel (both fetches called before either resolves)
  // -------------------------------------------------------------------------
  it('checks run in parallel — both fetches called before either resolves', async () => {
    const callOrder: string[] = []
    let resolveAlpha!: () => void
    let resolveBeta!: () => void

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('alpha')) {
        callOrder.push('alpha-called')
        return new Promise<Response>((resolve) => {
          resolveAlpha = () => {
            callOrder.push('alpha-resolved')
            resolve(makeMockResponse(200))
          }
        })
      } else {
        callOrder.push('beta-called')
        return new Promise<Response>((resolve) => {
          resolveBeta = () => {
            callOrder.push('beta-resolved')
            resolve(makeMockResponse(200))
          }
        })
      }
    })

    vi.stubGlobal('fetch', mockFetch)

    const routes = [makeRoute('alpha'), makeRoute('beta')]
    const checkPromise = checker.checkAll(routes)

    // At this point, both fetches should have been called (not yet resolved)
    await Promise.resolve() // flush microtasks
    expect(callOrder).toContain('alpha-called')
    expect(callOrder).toContain('beta-called')
    expect(callOrder).not.toContain('alpha-resolved')
    expect(callOrder).not.toContain('beta-resolved')

    // Now resolve both
    resolveAlpha()
    resolveBeta()
    await checkPromise

    expect(checker.getHealth('alpha')?.healthStatus).toBe('up')
    expect(checker.getHealth('beta')?.healthStatus).toBe('up')
  })

  // -------------------------------------------------------------------------
  // Additional: applyHealth applies health data to route objects in-place
  // -------------------------------------------------------------------------
  it('applyHealth sets health fields on route objects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(200)))

    const routes = [makeRoute('alpha')]
    await checker.checkAll(routes)

    const result = checker.applyHealth(routes)
    expect(result).toBe(routes) // same array reference
    expect(routes[0].healthStatus).toBe('up')
    expect(routes[0].responseTimeMs).toBeTypeOf('number')
    expect(routes[0].lastChecked).toBeTypeOf('string')
  })

  // -------------------------------------------------------------------------
  // Additional: non-OK non-404 status without prior 'up' → 'unknown'
  // -------------------------------------------------------------------------
  it('non-OK non-404 status without prior up → unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(500, false)))

    const routes = [makeRoute('svc')]
    await checker.checkAll(routes)

    expect(checker.getHealth('svc')?.healthStatus).toBe('unknown')
    expect(checker.getHealth('svc')?.responseTimeMs).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Additional: intervalMs <= 0 means start() does not schedule checks
  // -------------------------------------------------------------------------
  it('start() with intervalMs <= 0 does not schedule interval', () => {
    const noIntervalChecker = new AdapterHealthChecker({ intervalMs: 0, timeoutMs: 2000 })
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    noIntervalChecker.start(() => [makeRoute('alpha')])

    vi.advanceTimersByTime(60_000)

    expect(mockFetch).not.toHaveBeenCalled()
    noIntervalChecker.stop()
  })

  // -------------------------------------------------------------------------
  // Additional: start() schedules periodic checks; stop() cancels them
  // -------------------------------------------------------------------------
  it('start() schedules periodic checks; stop() cancels further calls', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeMockResponse(200))
    vi.stubGlobal('fetch', mockFetch)

    checker.start(() => [makeRoute('alpha')])

    // Advance past first interval
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Advance past second interval
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Stop and verify no more calls
    checker.stop()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // Additional: 404 route removed and re-added clears noHealthEndpoint cache
  // -------------------------------------------------------------------------
  it('re-adding a 404 route after removal resets the noHealthEndpoint cache', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeMockResponse(404, false)) // first check: 404
      .mockResolvedValueOnce(makeMockResponse(200)) // after re-add: 200

    vi.stubGlobal('fetch', mockFetch)

    const route = makeRoute('flaky')

    // First cycle: 404, cached as no-health-endpoint
    await checker.checkAll([route])
    expect(checker.getHealth('flaky')?.healthStatus).toBe('unknown')
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Second cycle: verify skip
    await checker.checkAll([route])
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Remove route — clears cache
    await checker.checkAll([])
    expect(checker.getHealth('flaky')).toBeUndefined()

    // Re-add route — should probe again
    await checker.checkAll([route])
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(checker.getHealth('flaky')?.healthStatus).toBe('up')
  })

  // -------------------------------------------------------------------------
  // Dispatch on status change
  // -------------------------------------------------------------------------
  it('dispatches LocalRouteHealthUpdate when status changes to up', async () => {
    const dispatchFn = vi.fn().mockResolvedValue(undefined)
    const dispatchChecker = new AdapterHealthChecker({
      intervalMs: 30_000,
      timeoutMs: 3_000,
      dispatchFn,
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(200)))
    await dispatchChecker.checkAll([makeRoute('alpha')])

    expect(dispatchFn).toHaveBeenCalledOnce()
    expect(dispatchFn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'local:route:health-update',
        data: expect.objectContaining({ name: 'alpha', healthStatus: 'up' }),
      })
    )
    dispatchChecker.stop()
  })

  it('does NOT dispatch when status stays the same', async () => {
    const dispatchFn = vi.fn().mockResolvedValue(undefined)
    const dispatchChecker = new AdapterHealthChecker({
      intervalMs: 30_000,
      timeoutMs: 3_000,
      dispatchFn,
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(200)))
    const routes = [makeRoute('alpha')]

    await dispatchChecker.checkAll(routes)
    expect(dispatchFn).toHaveBeenCalledOnce()

    await dispatchChecker.checkAll(routes)
    expect(dispatchFn).toHaveBeenCalledOnce() // still 1
    dispatchChecker.stop()
  })

  it('dispatches on status transition up → down', async () => {
    const dispatchFn = vi.fn().mockResolvedValue(undefined)
    const dispatchChecker = new AdapterHealthChecker({
      intervalMs: 30_000,
      timeoutMs: 3_000,
      dispatchFn,
    })

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeMockResponse(200))
      .mockRejectedValueOnce(new Error('timeout'))
    vi.stubGlobal('fetch', mockFetch)

    const routes = [makeRoute('alpha')]
    await dispatchChecker.checkAll(routes)
    await dispatchChecker.checkAll(routes)

    expect(dispatchFn).toHaveBeenCalledTimes(2)
    expect(dispatchFn.mock.calls[1][0].data.healthStatus).toBe('down')
    dispatchChecker.stop()
  })

  it('works without dispatchFn (backward compat)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(200)))
    await checker.checkAll([makeRoute('alpha')])
    expect(checker.getHealth('alpha')?.healthStatus).toBe('up')
  })
})
