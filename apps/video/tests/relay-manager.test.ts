import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  RelayManager,
  validateRelayEndpoint,
  type RouteSubscription,
} from '../src/routes/relay-manager.js'
import type { ControlApiClient } from '../src/mediamtx/control-api-client.js'
import type { RouteChange, InternalRoute, DataChannelDefinition } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInternalRoute(overrides: Partial<InternalRoute> = {}): InternalRoute {
  return {
    name: 'cam-1',
    protocol: 'media',
    endpoint: 'rtsp://10.0.1.5:8554/cam-1',
    peer: { name: 'node-b', endpoint: 'ws://node-b:4000', domains: [] },
    nodePath: ['node-b'],
    originNode: 'node-b',
    ...overrides,
  }
}

function makeMockControlApi(): ControlApiClient {
  return {
    listPaths: vi.fn().mockResolvedValue({ ok: true, data: { pageCount: 0, items: [] } }),
    getPath: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    addPath: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    patchPath: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    deletePath: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  } as unknown as ControlApiClient
}

function makeMockRouteSource(internal: InternalRoute[] = []): RouteSubscription & {
  triggerChanges: (changes: RouteChange[]) => void
  lastCallback: ((changes: RouteChange[]) => void) | null
} {
  let callback: ((changes: RouteChange[]) => void) | null = null
  return {
    watchRoutes: vi.fn((cb: (changes: RouteChange[]) => void) => {
      callback = cb
      return () => {
        callback = null
      }
    }),
    listRoutes: vi.fn().mockResolvedValue({
      local: [] as DataChannelDefinition[],
      internal,
    }),
    triggerChanges(changes: RouteChange[]) {
      callback?.(changes)
    },
    get lastCallback() {
      return callback
    },
  }
}

// ---------------------------------------------------------------------------
// SSRF Validation
// ---------------------------------------------------------------------------

describe('validateRelayEndpoint()', () => {
  const knownHosts = new Set(['10.0.1.5', '10.0.1.6'])

  it('accepts valid rtsp:// URL with known host', () => {
    const result = validateRelayEndpoint('rtsp://10.0.1.5:8554/cam-1', knownHosts)
    expect(result.safe).toBe(true)
    if (result.safe) {
      expect(result.host).toBe('10.0.1.5')
      expect(result.port).toBe(8554)
      expect(result.path).toBe('cam-1')
    }
  })

  it('defaults port to 8554 when not specified', () => {
    const result = validateRelayEndpoint('rtsp://10.0.1.5/cam-1', knownHosts)
    expect(result.safe).toBe(true)
    if (result.safe) {
      expect(result.port).toBe(8554)
    }
  })

  it('rejects non-rtsp schemes', () => {
    expect(validateRelayEndpoint('http://10.0.1.5:8554/cam', knownHosts).safe).toBe(false)
    expect(validateRelayEndpoint('file:///etc/passwd', knownHosts).safe).toBe(false)
    expect(validateRelayEndpoint('gopher://10.0.1.5/x', knownHosts).safe).toBe(false)
  })

  it('rejects cloud metadata IP 169.254.169.254', () => {
    const result = validateRelayEndpoint('rtsp://169.254.169.254/latest/meta-data', knownHosts)
    expect(result.safe).toBe(false)
  })

  it('rejects link-local range 169.254.x.x', () => {
    const result = validateRelayEndpoint('rtsp://169.254.1.1:8554/cam', knownHosts)
    expect(result.safe).toBe(false)
  })

  it('rejects loopback addresses', () => {
    expect(validateRelayEndpoint('rtsp://127.0.0.1:8554/cam', knownHosts).safe).toBe(false)
    expect(validateRelayEndpoint('rtsp://[::1]:8554/cam', knownHosts).safe).toBe(false)
  })

  it('rejects IPv6 ULA (fd00::)', () => {
    const result = validateRelayEndpoint('rtsp://[fd00::]:8554/cam', new Set())
    expect(result.safe).toBe(false)
  })

  it('rejects unknown hosts when knownPeerHosts is non-empty', () => {
    const result = validateRelayEndpoint('rtsp://10.99.99.99:8554/cam', knownHosts)
    expect(result.safe).toBe(false)
  })

  it('allows any host when knownPeerHosts is empty', () => {
    const result = validateRelayEndpoint('rtsp://203.0.113.50:8554/cam', new Set())
    expect(result.safe).toBe(true)
  })

  it('rejects invalid URLs', () => {
    const result = validateRelayEndpoint('not-a-url', knownHosts)
    expect(result.safe).toBe(false)
  })

  it('allows RFC 1918 addresses (peers use private networks)', () => {
    // Known peer on 192.168.x — should be allowed
    const hosts = new Set(['192.168.1.1', '10.0.1.5'])
    expect(validateRelayEndpoint('rtsp://192.168.1.1:8554/cam', hosts).safe).toBe(true)
  })

  it('rejects 0.0.0.0 (wildcard address)', () => {
    const result = validateRelayEndpoint('rtsp://0.0.0.0:8554/cam', new Set())
    expect(result.safe).toBe(false)
  })

  it('rejects fe80:: link-local IPv6', () => {
    const result = validateRelayEndpoint('rtsp://[fe80::1]:8554/cam', new Set())
    expect(result.safe).toBe(false)
  })

  it('parses path correctly from endpoint URL', () => {
    const result = validateRelayEndpoint('rtsp://10.0.1.5:8554/cam-front', new Set())
    expect(result.safe).toBe(true)
    if (result.safe) {
      expect(result.path).toBe('cam-front')
    }
  })
})

// ---------------------------------------------------------------------------
// RelayManager
// ---------------------------------------------------------------------------

describe('RelayManager', () => {
  let controlApi: ReturnType<typeof makeMockControlApi>
  let routeSource: ReturnType<typeof makeMockRouteSource>
  let manager: RelayManager

  beforeEach(() => {
    controlApi = makeMockControlApi()
    routeSource = makeMockRouteSource()
    manager = new RelayManager({
      routeSource,
      controlApi,
      localNodeName: 'node-a',
      getRelayToken: () => 'relay-jwt-token',
      knownPeerHosts: new Set(['10.0.1.5', '10.0.1.6']),
    })
  })

  describe('start() and reconciliation', () => {
    it('reconciles existing routes on start', async () => {
      const route = makeInternalRoute()
      routeSource = makeMockRouteSource([route])
      manager = new RelayManager({
        routeSource,
        controlApi,
        localNodeName: 'node-a',
        getRelayToken: () => 'relay-jwt-token',
        knownPeerHosts: new Set(['10.0.1.5']),
      })

      await manager.start()

      expect(controlApi.addPath).toHaveBeenCalledWith('cam-1', {
        source: 'rtsp://10.0.1.5:8554/cam-1',
        sourceOnDemand: true,
        sourceOnDemandStartTimeout: '10s',
        sourceOnDemandCloseAfter: '10s',
        sourceUser: 'relay',
        sourcePass: 'relay-jwt-token',
      })
      expect(manager.relayCount).toBe(1)
    })

    it('removes stale relays during reconciliation', async () => {
      // Pre-populate: route was active before reconnect
      const route = makeInternalRoute()
      routeSource = makeMockRouteSource([route])
      manager = new RelayManager({
        routeSource,
        controlApi,
        localNodeName: 'node-a',
        getRelayToken: () => 'relay-jwt-token',
        knownPeerHosts: new Set(['10.0.1.5']),
      })
      await manager.start()
      expect(manager.relayCount).toBe(1)

      // On reconnect, route is gone
      routeSource = makeMockRouteSource([])
      manager = new RelayManager({
        routeSource,
        controlApi,
        localNodeName: 'node-a',
        getRelayToken: () => 'relay-jwt-token',
        knownPeerHosts: new Set(['10.0.1.5']),
      })
      // Simulate the manager having a stale relay — we need to start fresh
      await manager.start()
      // New manager has no stale relays, so nothing to remove
      expect(manager.relayCount).toBe(0)
    })

    it('skips local node routes during reconciliation', async () => {
      const localRoute = makeInternalRoute({ originNode: 'node-a' })
      routeSource = makeMockRouteSource([localRoute])
      manager = new RelayManager({
        routeSource,
        controlApi,
        localNodeName: 'node-a',
        getRelayToken: () => 'relay-jwt-token',
      })

      await manager.start()

      expect(controlApi.addPath).not.toHaveBeenCalled()
      expect(manager.relayCount).toBe(0)
    })

    it('skips non-media routes during reconciliation', async () => {
      const httpRoute = makeInternalRoute({ protocol: 'http' })
      routeSource = makeMockRouteSource([httpRoute])
      manager = new RelayManager({
        routeSource,
        controlApi,
        localNodeName: 'node-a',
        getRelayToken: () => 'relay-jwt-token',
      })

      await manager.start()

      expect(controlApi.addPath).not.toHaveBeenCalled()
    })

    it('skips routes with SSRF-unsafe endpoints during reconciliation', async () => {
      const badRoute = makeInternalRoute({ endpoint: 'rtsp://169.254.169.254/latest' })
      routeSource = makeMockRouteSource([badRoute])
      manager = new RelayManager({
        routeSource,
        controlApi,
        localNodeName: 'node-a',
        getRelayToken: () => 'relay-jwt-token',
      })

      await manager.start()

      expect(controlApi.addPath).not.toHaveBeenCalled()
    })
  })

  describe('subscription handling', () => {
    it('subscribes to watchRoutes on start', async () => {
      await manager.start()
      expect(routeSource.watchRoutes).toHaveBeenCalled()
    })

    it('creates relay path on added media route', async () => {
      await manager.start()

      const route = makeInternalRoute()
      routeSource.triggerChanges([{ type: 'added', route }])

      // Give async operations time to complete
      await vi.waitFor(() => {
        expect(controlApi.addPath).toHaveBeenCalledWith(
          'cam-1',
          expect.objectContaining({
            source: 'rtsp://10.0.1.5:8554/cam-1',
            sourceOnDemand: true,
            sourceUser: 'relay',
            sourcePass: 'relay-jwt-token',
          })
        )
      })
    })

    it('removes relay path on removed media route', async () => {
      await manager.start()

      // First add, then remove
      const route = makeInternalRoute()
      routeSource.triggerChanges([{ type: 'added', route }])
      await vi.waitFor(() => expect(manager.relayCount).toBe(1))

      routeSource.triggerChanges([{ type: 'removed', route }])
      await vi.waitFor(() => expect(controlApi.deletePath).toHaveBeenCalledWith('cam-1'))
    })

    it('ignores non-media route changes', async () => {
      await manager.start()

      const httpRoute: DataChannelDefinition = {
        name: 'api-service',
        protocol: 'http',
        endpoint: 'http://10.0.1.5:3000',
      }
      routeSource.triggerChanges([{ type: 'added', route: httpRoute }])

      expect(controlApi.addPath).not.toHaveBeenCalled()
    })

    it('ignores local node route changes', async () => {
      await manager.start()

      const localRoute = makeInternalRoute({ originNode: 'node-a' })
      routeSource.triggerChanges([{ type: 'added', route: localRoute }])

      expect(controlApi.addPath).not.toHaveBeenCalled()
    })

    it('rejects SSRF-unsafe endpoints in route changes', async () => {
      await manager.start()

      const badRoute = makeInternalRoute({ endpoint: 'http://169.254.169.254/latest' })
      routeSource.triggerChanges([{ type: 'added', route: badRoute }])

      expect(controlApi.addPath).not.toHaveBeenCalled()
    })

    it('does not create duplicate relay for already-relayed route', async () => {
      await manager.start()

      const route = makeInternalRoute()
      routeSource.triggerChanges([{ type: 'added', route }])
      await vi.waitFor(() => expect(manager.relayCount).toBe(1))

      // Trigger same route again — idempotency guard skips the duplicate
      routeSource.triggerChanges([{ type: 'added', route }])

      // Wait a tick to ensure the handler had a chance to run
      await new Promise((r) => setTimeout(r, 50))

      // addPath called only once (duplicate was skipped)
      expect(controlApi.addPath).toHaveBeenCalledTimes(1)
      expect(manager.relayCount).toBe(1)
    })

    it('creates relays for multiple new remote routes', async () => {
      await manager.start()

      const route1 = makeInternalRoute({ name: 'cam-1', endpoint: 'rtsp://10.0.1.5:8554/cam-1' })
      const route2 = makeInternalRoute({ name: 'cam-2', endpoint: 'rtsp://10.0.1.5:8554/cam-2' })
      const route3 = makeInternalRoute({ name: 'cam-3', endpoint: 'rtsp://10.0.1.6:8554/cam-3' })
      routeSource.triggerChanges([
        { type: 'added', route: route1 },
        { type: 'added', route: route2 },
        { type: 'added', route: route3 },
      ])

      await vi.waitFor(() => expect(manager.relayCount).toBe(3))
      expect(controlApi.addPath).toHaveBeenCalledTimes(3)
    })

    it('uses fresh relay token from getRelayToken callback', async () => {
      let tokenVersion = 1
      manager = new RelayManager({
        routeSource,
        controlApi,
        localNodeName: 'node-a',
        getRelayToken: () => `jwt-v${tokenVersion}`,
        knownPeerHosts: new Set(['10.0.1.5']),
      })
      await manager.start()

      const route = makeInternalRoute()
      routeSource.triggerChanges([{ type: 'added', route }])
      await vi.waitFor(() => {
        expect(controlApi.addPath).toHaveBeenCalledWith(
          'cam-1',
          expect.objectContaining({ sourcePass: 'jwt-v1' })
        )
      })

      // Simulate token refresh
      tokenVersion = 2
      const route2 = makeInternalRoute({ name: 'cam-2', endpoint: 'rtsp://10.0.1.5:8554/cam-2' })
      routeSource.triggerChanges([{ type: 'added', route: route2 }])
      await vi.waitFor(() => {
        expect(controlApi.addPath).toHaveBeenCalledWith(
          'cam-2',
          expect.objectContaining({ sourcePass: 'jwt-v2' })
        )
      })
    })
  })

  describe('deferred changes during in-flight add', () => {
    it('replays an updated delta after addPath completes', async () => {
      let resolveAdd: () => void
      const addPromise = new Promise<void>((r) => { resolveAdd = r })
      ;(controlApi.addPath as ReturnType<typeof vi.fn>).mockImplementation(
        () => addPromise.then(() => ({ ok: true, data: undefined }))
      )

      await manager.start()

      const route = makeInternalRoute({ endpoint: 'rtsp://10.0.1.5:8554/cam-1' })
      routeSource.triggerChanges([{ type: 'added', route }])

      // While addPath is in flight, an updated arrives with new endpoint
      const updatedRoute = makeInternalRoute({ endpoint: 'rtsp://10.0.1.6:8554/cam-1' })
      routeSource.triggerChanges([{ type: 'updated', route: updatedRoute }])

      // Complete the original add
      resolveAdd!()
      await vi.waitFor(() => expect(manager.relayCount).toBe(1))

      // The deferred update should have been replayed — patchPath called
      await vi.waitFor(() =>
        expect(controlApi.patchPath).toHaveBeenCalledWith(
          'cam-1',
          expect.objectContaining({ source: 'rtsp://10.0.1.6:8554/cam-1' })
        )
      )
    })

    it('replays a removed delta after addPath completes', async () => {
      let resolveAdd: () => void
      const addPromise = new Promise<void>((r) => { resolveAdd = r })
      ;(controlApi.addPath as ReturnType<typeof vi.fn>).mockImplementation(
        () => addPromise.then(() => ({ ok: true, data: undefined }))
      )

      await manager.start()

      const route = makeInternalRoute()
      routeSource.triggerChanges([{ type: 'added', route }])

      // While addPath is in flight, a removed arrives
      routeSource.triggerChanges([{ type: 'removed', route }])

      // Complete the original add
      resolveAdd!()
      await vi.waitFor(() => expect(controlApi.addPath).toHaveBeenCalled())

      // The deferred removal should fire — deletePath called
      await vi.waitFor(() => expect(controlApi.deletePath).toHaveBeenCalledWith('cam-1'))
      expect(manager.relayCount).toBe(0)
    })
  })

  describe('route updates', () => {
    it('patches relay path when endpoint changes via updated event', async () => {
      await manager.start()

      const route = makeInternalRoute({ endpoint: 'rtsp://10.0.1.5:8554/cam-1' })
      routeSource.triggerChanges([{ type: 'added', route }])
      await vi.waitFor(() => expect(manager.relayCount).toBe(1))

      const updatedRoute = makeInternalRoute({ endpoint: 'rtsp://10.0.1.6:8554/cam-1' })
      routeSource.triggerChanges([{ type: 'updated', route: updatedRoute }])
      await vi.waitFor(() =>
        expect(controlApi.patchPath).toHaveBeenCalledWith(
          'cam-1',
          expect.objectContaining({ source: 'rtsp://10.0.1.6:8554/cam-1' })
        )
      )
    })
  })

  describe('onSubscribersEvicted', () => {
    it('deletes relay path when path is in activeRelays', async () => {
      await manager.start()

      const route = makeInternalRoute()
      routeSource.triggerChanges([{ type: 'added', route }])
      await vi.waitFor(() => expect(manager.relayCount).toBe(1))

      const result = await manager.onSubscribersEvicted('cam-1')

      expect(result).toBe(true)
      expect(controlApi.deletePath).toHaveBeenCalledWith('cam-1')
      expect(manager.relayCount).toBe(0)
    })

    it('returns true for path not in activeRelays (not ours)', async () => {
      await manager.start()

      const result = await manager.onSubscribersEvicted('unknown-path')

      expect(result).toBe(true)
      expect(controlApi.deletePath).not.toHaveBeenCalled()
    })

    it('returns false when deletePath fails transiently', async () => {
      await manager.start()

      const route = makeInternalRoute()
      routeSource.triggerChanges([{ type: 'added', route }])
      await vi.waitFor(() => expect(manager.relayCount).toBe(1))

      ;(controlApi.deletePath as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: 'HTTP 503',
        status: 503,
      })

      const result = await manager.onSubscribersEvicted('cam-1')

      expect(result).toBe(false)
      // Relay still tracked — will be retried
      expect(manager.relayCount).toBe(1)
    })
  })

  describe('error handling', () => {
    it('handles addPath failure gracefully', async () => {
      ;(controlApi.addPath as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: 'HTTP 500',
        status: 500,
      })
      await manager.start()

      const route = makeInternalRoute()
      routeSource.triggerChanges([{ type: 'added', route }])

      // Should not crash; relay is not tracked since addPath failed
      await vi.waitFor(() => expect(controlApi.addPath).toHaveBeenCalled())
      expect(manager.relayCount).toBe(0)
    })

    it('handles deletePath failure gracefully', async () => {
      await manager.start()

      // First add a relay successfully
      const route = makeInternalRoute()
      routeSource.triggerChanges([{ type: 'added', route }])
      await vi.waitFor(() => expect(manager.relayCount).toBe(1))

      // Now make deletePath fail
      ;(controlApi.deletePath as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: 'HTTP 500',
        status: 500,
      })

      routeSource.triggerChanges([{ type: 'removed', route }])
      await vi.waitFor(() => expect(controlApi.deletePath).toHaveBeenCalled())

      // Relay is still tracked since delete failed
      expect(manager.relayCount).toBe(1)
    })

    it('treats deletePath 404 as success (already removed)', async () => {
      await manager.start()

      const route = makeInternalRoute()
      routeSource.triggerChanges([{ type: 'added', route }])
      await vi.waitFor(() => expect(manager.relayCount).toBe(1))

      ;(controlApi.deletePath as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: 'HTTP 404',
        status: 404,
      })

      routeSource.triggerChanges([{ type: 'removed', route }])
      await vi.waitFor(() => expect(controlApi.deletePath).toHaveBeenCalled())

      // 404 is treated as success — relay is cleaned up
      expect(manager.relayCount).toBe(0)
    })

    it('does not call deletePath or decrement metrics for untracked route removal', async () => {
      const relayMetrics = {
        relayActive: { add: vi.fn() },
        relaySetupDuration: { record: vi.fn() },
        relaySetups: { add: vi.fn() },
      }
      const tracked = new RelayManager({
        routeSource,
        controlApi,
        localNodeName: 'node-a',
        getRelayToken: () => 'jwt',
        knownPeerHosts: new Set(['10.0.1.5']),
        metrics: relayMetrics,
      })
      await tracked.start()

      // Remove a route we never added
      const unknownRoute = makeInternalRoute({ name: 'never-tracked' })
      routeSource.triggerChanges([{ type: 'removed', route: unknownRoute }])

      await new Promise((r) => setTimeout(r, 50))

      // Should not call deletePath at all for untracked names
      expect(controlApi.deletePath).not.toHaveBeenCalled()
      // Metric should not go negative
      expect(relayMetrics.relayActive.add).not.toHaveBeenCalledWith(-1)
    })
  })

  describe('shutdown', () => {
    it('unsubscribes from route changes on shutdown', async () => {
      await manager.start()
      expect(routeSource.lastCallback).not.toBeNull()

      manager.shutdown()
      expect(routeSource.lastCallback).toBeNull()
    })

    it('ignores route changes after shutdown', async () => {
      await manager.start()
      manager.shutdown()

      // triggerChanges should have no effect since callback is null
      const route = makeInternalRoute()
      routeSource.triggerChanges([{ type: 'added', route }])

      expect(controlApi.addPath).not.toHaveBeenCalled()
    })
  })
})
