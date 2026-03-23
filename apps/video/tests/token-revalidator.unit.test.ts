import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TokenRevalidator } from '../src/session/token-revalidator.js'
import { SessionRegistry, type SessionEntry } from '../src/session/session-registry.js'

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 'sess-001',
    path: 'cam-front',
    protocol: 'rtsp',
    exp: Date.now() - 1000, // expired by default
    recordedAt: Date.now() - 60_000,
    ...overrides,
  }
}

function mockControlApi() {
  return {
    kickSession: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    listRtspSessions: vi.fn().mockResolvedValue({
      ok: true,
      data: { pageCount: 0, itemCount: 0, items: [] },
    }),
    listRtmpConns: vi.fn().mockResolvedValue({
      ok: true,
      data: { pageCount: 0, itemCount: 0, items: [] },
    }),
    listHlsMuxers: vi.fn().mockResolvedValue({
      ok: true,
      data: { pageCount: 0, itemCount: 0, items: [] },
    }),
  }
}

function mockMetrics() {
  return {
    sessionKicks: { add: vi.fn() },
    revalidationSweeps: { add: vi.fn() },
  }
}

describe('TokenRevalidator', () => {
  let registry: SessionRegistry
  let controlApi: ReturnType<typeof mockControlApi>
  let metrics: ReturnType<typeof mockMetrics>

  beforeEach(() => {
    registry = new SessionRegistry()
    controlApi = mockControlApi()
    metrics = mockMetrics()
  })

  describe('sweep', () => {
    it('kicks expired sessions and removes from registry', async () => {
      registry.add(makeEntry({ id: 'a', exp: Date.now() - 5000 }))

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        metrics,
      })

      const count = await revalidator.sweep()

      expect(count).toBe(1)
      expect(controlApi.kickSession).toHaveBeenCalledWith('a', 'rtsp')
      expect(registry.get('a')).toBeUndefined()
      expect(metrics.sessionKicks.add).toHaveBeenCalledWith(1, {
        reason: 'expired',
        protocol: 'rtsp',
      })
    })

    it('skips sessions with valid tokens (exp > now)', async () => {
      registry.add(makeEntry({ id: 'a', exp: Date.now() + 60_000 }))

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        metrics,
      })

      const count = await revalidator.sweep()

      expect(count).toBe(0)
      expect(controlApi.kickSession).not.toHaveBeenCalled()
      expect(registry.get('a')).toBeDefined()
    })

    it('removes entry on 404 but does NOT count as a kick', async () => {
      registry.add(makeEntry({ id: 'a' }))
      controlApi.kickSession.mockResolvedValue({ ok: false, error: 'HTTP 404', status: 404 })

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        metrics,
      })

      const count = await revalidator.sweep()

      // Entry removed (session already gone), but not counted as an active kick
      expect(count).toBe(0)
      expect(registry.get('a')).toBeUndefined()
      expect(metrics.sessionKicks.add).not.toHaveBeenCalled()
    })

    it('retains entry on transient failure (5xx)', async () => {
      registry.add(makeEntry({ id: 'a' }))
      controlApi.kickSession.mockResolvedValue({ ok: false, error: 'HTTP 503', status: 503 })

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        metrics,
      })

      const count = await revalidator.sweep()

      expect(count).toBe(0)
      expect(registry.get('a')).toBeDefined()
    })

    it('retains entry on network error', async () => {
      registry.add(makeEntry({ id: 'a' }))
      controlApi.kickSession.mockResolvedValue({ ok: false, error: 'ECONNREFUSED' })

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        metrics,
      })

      const count = await revalidator.sweep()

      expect(count).toBe(0)
      expect(registry.get('a')).toBeDefined()
    })

    it('fires onPathSubscribersEvicted when path has zero sessions after kick', async () => {
      registry.add(makeEntry({ id: 'a', path: 'relay-cam' }))
      const onEvicted = vi.fn().mockResolvedValue(true)

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        onPathSubscribersEvicted: onEvicted,
        metrics,
      })

      await revalidator.sweep()

      expect(onEvicted).toHaveBeenCalledWith('relay-cam')
    })

    it('does NOT fire eviction callback when other sessions remain on path', async () => {
      registry.add(makeEntry({ id: 'a', path: 'cam', exp: Date.now() - 1000 }))
      registry.add(makeEntry({ id: 'b', path: 'cam', exp: Date.now() + 60_000 }))
      const onEvicted = vi.fn().mockResolvedValue(true)

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        onPathSubscribersEvicted: onEvicted,
        metrics,
      })

      await revalidator.sweep()

      expect(onEvicted).not.toHaveBeenCalled()
    })

    it('removes expired HLS sessions without calling kick API or counting as kick', async () => {
      registry.add(makeEntry({ id: 'h1', protocol: 'hls' }))

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        metrics,
      })

      const count = await revalidator.sweep()

      // HLS is stateless — no kick API call, no kick count
      expect(controlApi.kickSession).not.toHaveBeenCalled()
      expect(count).toBe(0)
      expect(metrics.sessionKicks.add).not.toHaveBeenCalled()
      // But the entry IS removed from the registry
      expect(registry.get('h1')).toBeUndefined()
    })

    it('empty registry is a no-op', async () => {
      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        metrics,
      })

      const count = await revalidator.sweep()

      expect(count).toBe(0)
      expect(controlApi.kickSession).not.toHaveBeenCalled()
      expect(metrics.revalidationSweeps.add).toHaveBeenCalledWith(1)
    })

    it('kicks RTSP/RTMP and removes HLS across protocols', async () => {
      registry.add(makeEntry({ id: 'r1', protocol: 'rtsp' }))
      registry.add(makeEntry({ id: 'r2', protocol: 'rtmp' }))
      registry.add(makeEntry({ id: 'h1', protocol: 'hls' }))

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        metrics,
      })

      const count = await revalidator.sweep()

      // Only RTSP + RTMP count as kicks; HLS is silently removed
      expect(count).toBe(2)
      expect(registry.size).toBe(0)
      expect(controlApi.kickSession).toHaveBeenCalledTimes(2)
    })

    it('does not fire eviction callback on kick failure', async () => {
      registry.add(makeEntry({ id: 'a', path: 'relay-cam' }))
      controlApi.kickSession.mockResolvedValue({ ok: false, error: 'HTTP 503', status: 503 })
      const onEvicted = vi.fn().mockResolvedValue(true)

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        onPathSubscribersEvicted: onEvicted,
        metrics,
      })

      await revalidator.sweep()

      expect(onEvicted).not.toHaveBeenCalled()
    })
  })

  describe('reconcile', () => {
    it('removes leaked entries not in MediaMTX session lists', async () => {
      registry.add(makeEntry({ id: 'leaked', protocol: 'rtsp', exp: Date.now() + 60_000 }))
      // MediaMTX returns empty — session is gone

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
      })

      await revalidator.reconcile()

      expect(registry.get('leaked')).toBeUndefined()
    })

    it('preserves entries that ARE in MediaMTX session lists', async () => {
      registry.add(makeEntry({ id: 'active', protocol: 'rtsp', exp: Date.now() + 60_000 }))
      controlApi.listRtspSessions.mockResolvedValue({
        ok: true,
        data: { pageCount: 1, itemCount: 1, items: [{ id: 'active', path: 'cam-front' }] },
      })

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
      })

      await revalidator.reconcile()

      expect(registry.get('active')).toBeDefined()
    })

    it('matches HLS entries by path (no id field)', async () => {
      registry.add(makeEntry({ id: 'hls-1', protocol: 'hls', path: 'cam-front' }))
      controlApi.listHlsMuxers.mockResolvedValue({
        ok: true,
        data: { pageCount: 1, itemCount: 1, items: [{ path: 'cam-front' }] },
      })

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
      })

      await revalidator.reconcile()

      expect(registry.get('hls-1')).toBeDefined()
    })

    it('fires eviction callback immediately when reconcile removes last session on a path', async () => {
      registry.add(makeEntry({ id: 'only-viewer', protocol: 'rtsp', path: 'relay-cam', exp: Date.now() + 60_000 }))
      // MediaMTX says session is gone
      const onEvicted = vi.fn().mockResolvedValue(true)

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        onPathSubscribersEvicted: onEvicted,
      })

      await revalidator.reconcile()

      expect(registry.get('only-viewer')).toBeUndefined()
      // Eviction fires inline during reconcile — no need to wait for next sweep
      expect(onEvicted).toHaveBeenCalledWith('relay-cam')
    })

    it('removes HLS entry when path is not in muxer list', async () => {
      registry.add(makeEntry({ id: 'hls-gone', protocol: 'hls', path: 'old-stream' }))

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
      })

      await revalidator.reconcile()

      expect(registry.get('hls-gone')).toBeUndefined()
    })

    it('skips protocol when its list API fails instead of purging entries', async () => {
      registry.add(makeEntry({ id: 'rtsp-1', protocol: 'rtsp', exp: Date.now() + 60_000 }))
      registry.add(makeEntry({ id: 'rtmp-1', protocol: 'rtmp', exp: Date.now() + 60_000 }))

      // RTSP list fails, RTMP succeeds with empty list
      controlApi.listRtspSessions.mockResolvedValue({
        ok: false,
        error: 'ECONNREFUSED',
      })
      controlApi.listRtmpConns.mockResolvedValue({
        ok: true,
        data: { pageCount: 0, itemCount: 0, items: [] },
      })

      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
      })

      await revalidator.reconcile()

      // RTSP entry preserved (list failed — skip that protocol)
      expect(registry.get('rtsp-1')).toBeDefined()
      // RTMP entry removed (list succeeded, session not in it)
      expect(registry.get('rtmp-1')).toBeUndefined()
    })
  })

  describe('start / stop', () => {
    it('start is idempotent', () => {
      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        sweepIntervalMs: 100_000,
      })
      revalidator.start()
      revalidator.start() // second call is no-op
      revalidator.stop()
    })

    it('stop clears timers', () => {
      const revalidator = new TokenRevalidator({
        registry,
        controlApi: controlApi as any,
        sweepIntervalMs: 100_000,
      })
      revalidator.start()
      revalidator.stop()
      // no assertion needed — just verify no timer leak (vitest detects open handles)
    })
  })
})
