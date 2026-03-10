import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StreamCatalog } from '../../src/v2/video-notifier.js'
import { VideoConnectionManager } from '../../src/v2/video-connection.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSessionFactory() {
  const mockUpdateStreamCatalog = vi.fn().mockResolvedValue(undefined)
  const mockRefreshToken = vi.fn().mockResolvedValue(undefined)
  const mockGetVideoClient = vi.fn().mockResolvedValue({
    success: true,
    client: { updateStreamCatalog: mockUpdateStreamCatalog, refreshToken: mockRefreshToken },
  })
  const createSession = vi.fn().mockReturnValue({ getVideoClient: mockGetVideoClient })
  return { createSession, mockGetVideoClient, mockUpdateStreamCatalog, mockRefreshToken }
}

function createManager(
  overrides: Partial<{
    createSession: ReturnType<typeof createMockSessionFactory>['createSession']
    buildDispatchCapability: () => unknown
    onConnected: () => Promise<void>
    logger: { info(msg: string): void; warn(msg: string): void }
    backoff: { initialDelayMs?: number; maxDelayMs?: number }
  }> = {}
) {
  const factory = createMockSessionFactory()
  const onConnected = overrides.onConnected ?? vi.fn().mockResolvedValue(undefined)
  const logger = overrides.logger ?? { info: vi.fn(), warn: vi.fn() }
  const buildDispatchCapability = overrides.buildDispatchCapability ?? vi.fn().mockReturnValue({})

  const manager = new VideoConnectionManager({
    endpoint: 'ws://video:5000',
    createSession: overrides.createSession ?? factory.createSession,
    buildDispatchCapability,
    onConnected,
    logger,
    backoff: overrides.backoff,
  })

  return { manager, factory, onConnected, logger, buildDispatchCapability }
}

const testCatalog: StreamCatalog = {
  streams: [{ name: 'cam-front', protocol: 'media', source: 'local', sourceNode: 'node-a' }],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VideoConnectionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // T401 — State transitions: idle -> connecting -> connected
  describe('state transitions', () => {
    it('T401: transitions idle -> connecting -> connected on successful connect', async () => {
      const { manager } = createManager()

      expect(manager.status).toBe('idle')

      manager.start()
      expect(manager.status).toBe('connecting')

      // Flush the async connect attempt
      await vi.advanceTimersByTimeAsync(0)

      expect(manager.status).toBe('connected')

      manager.stop()
    })
  })

  // T402 — pushCatalog delegates when connected, silent when disconnected
  describe('pushCatalog', () => {
    it('T402: delegates to client when connected, returns silently when disconnected', async () => {
      const { manager, factory } = createManager()

      // Before connecting — should not throw, should not call RPC
      await manager.pushCatalog(testCatalog)
      expect(factory.mockUpdateStreamCatalog).not.toHaveBeenCalled()

      // Connect
      manager.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.status).toBe('connected')

      // Now push should delegate
      await manager.pushCatalog(testCatalog)
      expect(factory.mockUpdateStreamCatalog).toHaveBeenCalledWith(testCatalog)

      manager.stop()
    })
  })

  // T403 — Drop detection: pushCatalog RPC failure triggers reconnecting
  describe('drop detection', () => {
    it('T403: pushCatalog RPC failure transitions to reconnecting and schedules timer', async () => {
      const { manager, factory } = createManager()

      manager.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.status).toBe('connected')

      // Make the next RPC call fail
      factory.mockUpdateStreamCatalog.mockRejectedValueOnce(new Error('connection lost'))

      await manager.pushCatalog(testCatalog)

      expect(manager.status).toBe('reconnecting')

      manager.stop()
    })
  })

  // T404 — Exponential backoff delays
  describe('exponential backoff', () => {
    it('T404: delays are 1s, 2s, 4s, 8s, 16s, 30s (capped)', async () => {
      // Neutralize jitter: random=0.5 => factor = 1 - 0.2 + 0.5*0.4 = 1.0
      vi.spyOn(Math, 'random').mockReturnValue(0.5)

      const factory = createMockSessionFactory()
      // Make getVideoClient always fail to force repeated reconnects
      factory.mockGetVideoClient.mockRejectedValue(new Error('refused'))

      const { manager } = createManager({
        createSession: factory.createSession,
        backoff: { initialDelayMs: 1000, maxDelayMs: 30_000 },
      })

      // Spy on createSession to track connect attempts
      const callTimes: number[] = []
      factory.createSession.mockImplementation((_url: string) => {
        callTimes.push(Date.now())
        return { getVideoClient: factory.mockGetVideoClient }
      })

      manager.start()
      // Initial connect attempt fires immediately (via microtask)
      await vi.advanceTimersByTimeAsync(0)
      expect(callTimes).toHaveLength(1) // attempt 1 at t=0

      // Expected delays: 1s, 2s, 4s, 8s, 16s, 30s
      const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000]
      for (const delay of expectedDelays) {
        // Advance just before the delay — should not have fired yet
        await vi.advanceTimersByTimeAsync(delay - 1)
        const countBefore = callTimes.length

        // Advance 1ms more — should fire
        await vi.advanceTimersByTimeAsync(1)
        expect(callTimes.length).toBe(countBefore + 1)
      }

      manager.stop()
      vi.spyOn(Math, 'random').mockRestore()
    })
  })

  // T405 — Jitter
  describe('jitter', () => {
    it('T405: delays are within [0.8x, 1.2x] of base delay', async () => {
      // We test this by creating a manager with a known seed scenario
      // and verifying the delay falls within bounds.
      // We run 20 iterations to statistically verify jitter.
      const observedDelays: number[] = []

      for (let i = 0; i < 20; i++) {
        vi.useRealTimers()
        vi.useFakeTimers()

        const factory = createMockSessionFactory()
        let connectCount = 0
        factory.mockGetVideoClient.mockRejectedValue(new Error('refused'))
        factory.createSession.mockImplementation((_url: string) => {
          connectCount++
          return { getVideoClient: factory.mockGetVideoClient }
        })

        const mgr = new VideoConnectionManager({
          endpoint: 'ws://video:5000',
          createSession: factory.createSession,
          buildDispatchCapability: vi.fn().mockReturnValue({}),
          onConnected: vi.fn().mockResolvedValue(undefined),
          logger: { info: vi.fn(), warn: vi.fn() },
          backoff: { initialDelayMs: 1000, maxDelayMs: 30_000 },
        })

        mgr.start()
        await vi.advanceTimersByTimeAsync(0) // initial connect attempt
        expect(connectCount).toBe(1)

        // Now measure how long until the second attempt fires
        // Try advancing 1ms at a time up to 1500ms
        const startTime = Date.now()
        while (connectCount < 2) {
          await vi.advanceTimersByTimeAsync(1)
          if (Date.now() - startTime > 2000) break // safety
        }
        const elapsed = Date.now() - startTime
        observedDelays.push(elapsed)

        mgr.stop()
      }

      // All observed delays should be within [800, 1200] (0.8 * 1000, 1.2 * 1000)
      for (const delay of observedDelays) {
        expect(delay).toBeGreaterThanOrEqual(800)
        expect(delay).toBeLessThanOrEqual(1200)
      }

      // At least some variation should exist (not all the same)
      const unique = new Set(observedDelays)
      expect(unique.size).toBeGreaterThan(1)
    })
  })

  // T406 — Attempt counter resets on successful reconnect
  describe('attempt counter reset', () => {
    it('T406: resets to 0 on successful reconnect so next delay is ~1s', async () => {
      const factory = createMockSessionFactory()
      let connectAttempt = 0

      factory.createSession.mockImplementation((_url: string) => {
        connectAttempt++
        return { getVideoClient: factory.mockGetVideoClient }
      })

      // First connect fails 3 times, then succeeds
      factory.mockGetVideoClient
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockRejectedValueOnce(new Error('fail 3'))
        .mockResolvedValueOnce({
          success: true,
          client: {
            updateStreamCatalog: vi.fn().mockRejectedValue(new Error('drop')),
            refreshToken: vi.fn().mockResolvedValue(undefined),
          },
        })

      const { manager, onConnected } = createManager({ createSession: factory.createSession })

      manager.start()
      await vi.advanceTimersByTimeAsync(0) // attempt 1 (fail)
      await vi.advanceTimersByTimeAsync(1200) // attempt 2 at ~1s (fail)
      await vi.advanceTimersByTimeAsync(2400) // attempt 3 at ~2s (fail)
      await vi.advanceTimersByTimeAsync(4800) // attempt 4 at ~4s (success)

      expect(manager.status).toBe('connected')
      expect(onConnected).toHaveBeenCalled()

      // Now trigger a drop — the pushCatalog will fail
      await manager.pushCatalog(testCatalog)
      expect(manager.status).toBe('reconnecting')

      // Make next connect succeed
      factory.mockGetVideoClient.mockResolvedValueOnce({
        success: true,
        client: {
          updateStreamCatalog: factory.mockUpdateStreamCatalog,
          refreshToken: factory.mockRefreshToken,
        },
      })

      // Next reconnect delay should be ~1s (reset), not ~8s
      const countBefore = connectAttempt
      await vi.advanceTimersByTimeAsync(1200) // within 1s jitter range
      expect(connectAttempt).toBe(countBefore + 1)

      manager.stop()
    })
  })

  // T407 — Duplicate drop signals: two concurrent pushCatalog failures -> one timer
  describe('duplicate drop signals', () => {
    it('T407: two concurrent pushCatalog failures result in only one reconnect timer', async () => {
      const factory = createMockSessionFactory()
      const { manager } = createManager({ createSession: factory.createSession })

      manager.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.status).toBe('connected')

      // Make RPC fail
      factory.mockUpdateStreamCatalog.mockRejectedValue(new Error('connection lost'))

      // Fire two pushCatalog calls concurrently
      await Promise.all([manager.pushCatalog(testCatalog), manager.pushCatalog(testCatalog)])

      expect(manager.status).toBe('reconnecting')

      // Now make connect succeed on reconnect
      factory.mockUpdateStreamCatalog.mockResolvedValue(undefined)

      // Advance time — should only get ONE reconnect attempt
      factory.createSession.mockClear()
      await vi.advanceTimersByTimeAsync(1200)

      // Should have exactly 1 new session creation (the reconnect)
      expect(factory.createSession).toHaveBeenCalledTimes(1)

      manager.stop()
    })
  })

  // T408 — stop() cancels pending timer, no further attempts
  describe('stop()', () => {
    it('T408: cancels pending timer, state -> stopped, no further attempts', async () => {
      const factory = createMockSessionFactory()
      factory.mockGetVideoClient.mockRejectedValue(new Error('refused'))

      const { manager } = createManager({ createSession: factory.createSession })

      manager.start()
      await vi.advanceTimersByTimeAsync(0) // initial connect fails
      expect(manager.status).toBe('reconnecting')

      manager.stop()
      expect(manager.status).toBe('stopped')

      // Clear the call count before advancing time
      factory.createSession.mockClear()

      // Advance time — no new connect attempts should fire
      await vi.advanceTimersByTimeAsync(60_000)
      expect(factory.createSession).not.toHaveBeenCalled()
    })
  })

  // T409 — Initial connection failure enters backoff loop
  describe('initial connection failure', () => {
    it('T409: start() with failing session enters backoff loop, not permanent failure', async () => {
      const factory = createMockSessionFactory()
      factory.mockGetVideoClient.mockRejectedValue(new Error('refused'))

      const { manager } = createManager({ createSession: factory.createSession })

      manager.start()
      await vi.advanceTimersByTimeAsync(0) // initial attempt fails

      expect(manager.status).toBe('reconnecting')

      // Make the next attempt succeed
      factory.mockGetVideoClient.mockResolvedValueOnce({
        success: true,
        client: {
          updateStreamCatalog: factory.mockUpdateStreamCatalog,
          refreshToken: factory.mockRefreshToken,
        },
      })

      // Advance past first backoff delay (~1s)
      await vi.advanceTimersByTimeAsync(1200)

      expect(manager.status).toBe('connected')

      manager.stop()
    })
  })

  // T410 — Token push on reconnect
  describe('token push on reconnect', () => {
    it('T410: setNodeToken before reconnect causes refreshToken to be called after reconnect', async () => {
      const factory = createMockSessionFactory()
      const { manager } = createManager({ createSession: factory.createSession })

      manager.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.status).toBe('connected')

      // Set a token
      manager.setNodeToken('tok')

      // Now trigger a disconnect
      factory.mockUpdateStreamCatalog.mockRejectedValueOnce(new Error('drop'))
      await manager.pushCatalog(testCatalog)
      expect(manager.status).toBe('reconnecting')

      // Clear mocks to observe reconnect behavior
      factory.mockRefreshToken.mockClear()

      // Advance past reconnect delay
      await vi.advanceTimersByTimeAsync(1200)
      expect(manager.status).toBe('connected')

      // refreshToken should have been called with 'tok' on the new connection
      expect(factory.mockRefreshToken).toHaveBeenCalledWith('tok')

      manager.stop()
    })
  })

  // T411 — onConnected callback fires on each successful (re)connection
  describe('onConnected callback', () => {
    it('T411: fires on initial connect and on each reconnect', async () => {
      const factory = createMockSessionFactory()
      const onConnected = vi.fn().mockResolvedValue(undefined)
      const { manager } = createManager({
        createSession: factory.createSession,
        onConnected,
      })

      // Initial connect
      manager.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(onConnected).toHaveBeenCalledTimes(1)

      // Trigger disconnect
      factory.mockUpdateStreamCatalog.mockRejectedValueOnce(new Error('drop'))
      await manager.pushCatalog(testCatalog)

      // Reconnect
      await vi.advanceTimersByTimeAsync(1200)
      expect(onConnected).toHaveBeenCalledTimes(2)

      manager.stop()
    })
  })

  // T412 — Capability exchange: getVideoClient called with dispatch on EACH connect
  describe('capability exchange', () => {
    it('T412: getVideoClient called with dispatch capability on each connect', async () => {
      const factory = createMockSessionFactory()
      const dispatchCap = { dispatch: vi.fn() }
      const buildDispatchCapability = vi.fn().mockReturnValue(dispatchCap)

      const { manager } = createManager({
        createSession: factory.createSession,
        buildDispatchCapability,
      })

      // Initial connect
      manager.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(factory.mockGetVideoClient).toHaveBeenCalledTimes(1)
      expect(factory.mockGetVideoClient).toHaveBeenCalledWith(dispatchCap)
      expect(buildDispatchCapability).toHaveBeenCalledTimes(1)

      // Trigger disconnect
      factory.mockUpdateStreamCatalog.mockRejectedValueOnce(new Error('drop'))
      await manager.pushCatalog(testCatalog)

      // Reconnect
      await vi.advanceTimersByTimeAsync(1200)
      expect(factory.mockGetVideoClient).toHaveBeenCalledTimes(2)
      expect(buildDispatchCapability).toHaveBeenCalledTimes(2)

      manager.stop()
    })
  })

  // T413 — pushCatalog after stop(): silent return, no RPC call
  describe('pushCatalog after stop', () => {
    it('T413: returns silently, no RPC call, no error', async () => {
      const factory = createMockSessionFactory()
      const { manager } = createManager({ createSession: factory.createSession })

      manager.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.status).toBe('connected')

      manager.stop()
      expect(manager.status).toBe('stopped')

      factory.mockUpdateStreamCatalog.mockClear()

      // Should not throw and should not call RPC
      await expect(manager.pushCatalog(testCatalog)).resolves.toBeUndefined()
      expect(factory.mockUpdateStreamCatalog).not.toHaveBeenCalled()
    })
  })
})
