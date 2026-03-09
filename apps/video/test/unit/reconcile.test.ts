import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createReconciler } from '../../src/reconcile.js'
import { StreamRelayManager } from '../../src/stream-relay-manager.js'
import type { StreamCatalog } from '../../src/bus-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRelayManager() {
  return new StreamRelayManager(
    { relayGracePeriodMs: 30_000 },
    {
      onRelayStart: vi.fn(async () => {}),
      onRelayTeardown: vi.fn(async () => {}),
      deletePath: vi.fn(async () => {}),
    }
  )
}

function makeCatalog(names: string[]): StreamCatalog {
  return {
    streams: names.map((name) => ({
      name,
      protocol: 'rtsp',
      source: 'remote' as const,
      sourceNode: 'node-a',
    })),
  }
}

function pathItem(name: string, readerCount: number, sourceType: string | null = 'rtspSource') {
  return {
    name,
    source: sourceType ? { type: sourceType } : null,
    readers: Array.from({ length: readerCount }, () => ({ type: 'rtspSession' })),
  }
}

function successResponse(items: unknown[]) {
  return {
    ok: true,
    json: async () => ({ items }),
  }
}

function deleteSuccessResponse() {
  return { ok: true, json: async () => ({}) }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconcile', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('tears down orphan paths not in catalog', async () => {
    const mockFetch = vi.fn()
    const relayManager = makeRelayManager()
    const catalog = makeCatalog(['cam-a', 'cam-b'])

    // GET /v3/paths/list returns 3 paths; cam-c is NOT in catalog
    mockFetch.mockResolvedValueOnce(
      successResponse([pathItem('cam-a', 1), pathItem('cam-b', 0), pathItem('cam-c', 2)])
    )
    // DELETE for orphan cam-c
    mockFetch.mockResolvedValueOnce(deleteSuccessResponse())

    const reconciler = createReconciler({
      mediamtxApiUrl: 'http://localhost:9997',
      relayManager,
      getCatalog: () => catalog,
      fetchFn: mockFetch as unknown as typeof fetch,
    })

    await reconciler.reconcile()

    // Verify DELETE was called for orphan
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const deleteCall = mockFetch.mock.calls[1]!
    expect(deleteCall[0]).toBe('http://localhost:9997/v3/paths/cam-c')
    expect(deleteCall[1]).toEqual({ method: 'DELETE' })

    // cam-a was adopted (has readers), cam-b got grace period
    expect(relayManager.getSession('cam-a')?.activeViewers).toBe(1)
    expect(relayManager.getSession('cam-b')?.activeViewers).toBe(0)
    // cam-c should NOT be adopted (it's an orphan)
    expect(relayManager.getSession('cam-c')).toBeUndefined()
  })

  it('adopts path with readers into relay manager with correct viewer count', async () => {
    const mockFetch = vi.fn()
    const relayManager = makeRelayManager()
    const catalog = makeCatalog(['node-a/cam-front'])

    mockFetch.mockResolvedValueOnce(successResponse([pathItem('node-a/cam-front', 3)]))

    const reconciler = createReconciler({
      mediamtxApiUrl: 'http://localhost:9997',
      relayManager,
      getCatalog: () => catalog,
      fetchFn: mockFetch as unknown as typeof fetch,
    })

    await reconciler.reconcile()

    const session = relayManager.getSession('node-a/cam-front')
    expect(session).toBeDefined()
    expect(session!.activeViewers).toBe(3)
  })

  it('starts grace period for path with 0 readers that is in catalog', async () => {
    const mockFetch = vi.fn()
    const relayManager = makeRelayManager()
    const catalog = makeCatalog(['cam-idle'])

    mockFetch.mockResolvedValueOnce(successResponse([pathItem('cam-idle', 0)]))

    const reconciler = createReconciler({
      mediamtxApiUrl: 'http://localhost:9997',
      relayManager,
      getCatalog: () => catalog,
      fetchFn: mockFetch as unknown as typeof fetch,
    })

    await reconciler.reconcile()

    const session = relayManager.getSession('cam-idle')
    expect(session).toBeDefined()
    expect(session!.activeViewers).toBe(0)
    // Grace period timer should be set
    expect(session!.gracePeriodTimer).not.toBeNull()
  })

  it('retries 5x on MediaMTX API failure and does not crash', async () => {
    const mockFetch = vi.fn()
    const relayManager = makeRelayManager()
    const catalog = makeCatalog([])

    // All 5 attempts fail
    for (let i = 0; i < 5; i++) {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'))
    }

    const reconciler = createReconciler({
      mediamtxApiUrl: 'http://localhost:9997',
      relayManager,
      getCatalog: () => catalog,
      fetchFn: mockFetch as unknown as typeof fetch,
    })

    // Need to advance timers for the backoff delays
    const reconcilePromise = reconciler.reconcile()

    // Advance through 4 retry delays: 1s, 2s, 4s, 8s
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(4_000)
    await vi.advanceTimersByTimeAsync(8_000)

    await reconcilePromise

    // Should have attempted 5 times total
    expect(mockFetch).toHaveBeenCalledTimes(5)
  })

  it('encodes path segments individually for DELETE', async () => {
    const mockFetch = vi.fn()
    const relayManager = makeRelayManager()
    // cam with slash is NOT in catalog -> orphan
    const catalog = makeCatalog([])

    mockFetch.mockResolvedValueOnce(successResponse([pathItem('node a/cam front', 0)]))
    mockFetch.mockResolvedValueOnce(deleteSuccessResponse())

    const reconciler = createReconciler({
      mediamtxApiUrl: 'http://localhost:9997',
      relayManager,
      getCatalog: () => catalog,
      fetchFn: mockFetch as unknown as typeof fetch,
    })

    await reconciler.reconcile()

    const deleteCall = mockFetch.mock.calls[1]!
    expect(deleteCall[0]).toBe('http://localhost:9997/v3/paths/node%20a/cam%20front')
  })

  it('treats all paths as orphans when catalog is empty', async () => {
    const mockFetch = vi.fn()
    const relayManager = makeRelayManager()
    const catalog = makeCatalog([]) // empty catalog

    mockFetch.mockResolvedValueOnce(
      successResponse([pathItem('cam-a', 2), pathItem('cam-b', 0), pathItem('cam-c', 1)])
    )
    // 3 DELETE calls for all orphans
    mockFetch.mockResolvedValueOnce(deleteSuccessResponse())
    mockFetch.mockResolvedValueOnce(deleteSuccessResponse())
    mockFetch.mockResolvedValueOnce(deleteSuccessResponse())

    const reconciler = createReconciler({
      mediamtxApiUrl: 'http://localhost:9997',
      relayManager,
      getCatalog: () => catalog,
      fetchFn: mockFetch as unknown as typeof fetch,
    })

    await reconciler.reconcile()

    // All 3 paths should be deleted (1 GET + 3 DELETE = 4 calls)
    expect(mockFetch).toHaveBeenCalledTimes(4)
    // No sessions adopted
    expect(relayManager.getSession('cam-a')).toBeUndefined()
    expect(relayManager.getSession('cam-b')).toBeUndefined()
    expect(relayManager.getSession('cam-c')).toBeUndefined()
  })

  it('handles MediaMTX response with null items gracefully', async () => {
    const mockFetch = vi.fn()
    const relayManager = makeRelayManager()

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: null }),
    })

    const reconciler = createReconciler({
      mediamtxApiUrl: 'http://localhost:9997',
      relayManager,
      getCatalog: () => makeCatalog(['cam-a']),
      fetchFn: mockFetch as unknown as typeof fetch,
    })

    // Should not throw
    await reconciler.reconcile()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  describe('queue-latest mutex semantics', () => {
    it('queues reconciliation when one is already running; latest wins', async () => {
      // Use real timers — this test exercises Promise-based mutex, not setTimeout delays
      vi.useRealTimers()

      let fetchCallCount = 0
      let resolveFirstFetch: (() => void) | null = null

      const mockFetch = vi.fn(async (_url: string) => {
        fetchCallCount++
        if (fetchCallCount === 1) {
          // First reconciliation: block until we release it
          await new Promise<void>((resolve) => {
            resolveFirstFetch = resolve
          })
        }
        return successResponse([])
      })

      const relayManager = makeRelayManager()
      let catalogVersion = 0
      const getCatalog = vi.fn(() => {
        catalogVersion++
        return makeCatalog([`cam-v${catalogVersion}`])
      })

      const reconciler = createReconciler({
        mediamtxApiUrl: 'http://localhost:9997',
        relayManager,
        getCatalog,
        fetchFn: mockFetch as unknown as typeof fetch,
      })

      // Start first reconciliation (will block on fetch)
      const p1 = reconciler.reconcile()

      // Wait a tick so first reconciliation starts
      await new Promise((r) => setTimeout(r, 10))

      // Queue two more while first is running
      const p2 = reconciler.reconcile()
      const p3 = reconciler.reconcile()

      // Release first fetch
      resolveFirstFetch!()

      // Wait for all to complete
      await p1
      await Promise.all([p2, p3])

      // First reconciliation fetched once, then p2 and p3 are coalesced into
      // a single queued reconciliation run. Both promises resolve when it completes.
      // Total: 2 fetch calls for GET (first + one coalesced queued run)
      expect(mockFetch).toHaveBeenCalledTimes(2)

      // Restore fake timers for other tests
      vi.useFakeTimers()
    })

    it('runs normally when no concurrent reconciliation', async () => {
      const mockFetch = vi.fn()
      const relayManager = makeRelayManager()
      const catalog = makeCatalog([])

      mockFetch.mockResolvedValue(successResponse([]))

      const reconciler = createReconciler({
        mediamtxApiUrl: 'http://localhost:9997',
        relayManager,
        getCatalog: () => catalog,
        fetchFn: mockFetch as unknown as typeof fetch,
      })

      await reconciler.reconcile()
      await reconciler.reconcile()

      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })
})
