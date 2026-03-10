import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StreamCatalog } from '../../src/v2/video-notifier.js'

// ---------------------------------------------------------------------------
// Module mocks — vi.hoisted() ensures these are available when vi.mock runs
// ---------------------------------------------------------------------------

const {
  mockUpdateStreamCatalog,
  mockRefreshToken,
  mockGetVideoClient,
  mockNewWebSocketRpcSession,
} = vi.hoisted(() => {
  const mockUpdateStreamCatalog = vi.fn().mockResolvedValue(undefined)
  const mockRefreshToken = vi.fn().mockResolvedValue(undefined)

  const mockGetVideoClient = vi.fn().mockResolvedValue({
    success: true as const,
    client: {
      updateStreamCatalog: mockUpdateStreamCatalog,
      refreshToken: mockRefreshToken,
    },
  })

  const mockNewWebSocketRpcSession = vi.fn().mockImplementation(() => ({
    getVideoClient: mockGetVideoClient,
    permissions: vi.fn().mockResolvedValue({
      authorizeAction: vi.fn().mockResolvedValue({ success: true, allowed: true }),
    }),
    tokens: vi.fn().mockResolvedValue({
      create: vi.fn().mockResolvedValue('minted-node-token'),
    }),
  }))

  return {
    mockUpdateStreamCatalog,
    mockRefreshToken,
    mockGetVideoClient,
    mockNewWebSocketRpcSession,
  }
})

vi.mock('capnweb', async (importOriginal) => {
  const mod: Record<string, unknown> = await importOriginal()
  return {
    ...mod,
    newWebSocketRpcSession: mockNewWebSocketRpcSession,
  }
})

vi.mock('@hono/capnweb', () => ({
  newRpcResponse: vi.fn().mockReturnValue(new Response()),
}))

// Mock WebSocketPeerTransport with a real class so `new` works
vi.mock('../../src/v2/ws-transport.js', () => {
  class MockWebSocketPeerTransport {
    sendUpdate = vi.fn().mockResolvedValue(undefined)
    sendKeepalive = vi.fn().mockResolvedValue(undefined)
    openPeer = vi.fn().mockResolvedValue(undefined)
    closePeer = vi.fn().mockResolvedValue(undefined)
  }
  return { WebSocketPeerTransport: MockWebSocketPeerTransport }
})

// Mock getUpgradeWebSocket since it depends on Hono request context
vi.mock('@catalyst/service', async (importOriginal) => {
  const mod: Record<string, unknown> = await importOriginal()
  return {
    ...mod,
    getUpgradeWebSocket: vi.fn().mockReturnValue(vi.fn()),
  }
})

// ---------------------------------------------------------------------------
// Imports (after mocks are declared)
// ---------------------------------------------------------------------------

import { TelemetryBuilder } from '@catalyst/telemetry'
import { OrchestratorService } from '../../src/v2/catalyst-service.js'
import type { CatalystConfig } from '@catalyst/config'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<CatalystConfig['orchestrator']>): CatalystConfig {
  return {
    node: {
      name: 'test-node',
      domains: ['test.local'],
      endpoint: 'ws://test-node:4000',
    },
    port: 3000,
    orchestrator: {
      videoEndpoint: undefined,
      ...overrides,
    },
  }
}

function makeTelemetry() {
  return TelemetryBuilder.noop('orchestrator-test')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Video service wiring (OrchestratorService)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    // Ensure no leftover timers
    vi.restoreAllMocks()
  })

  // T307 ----------------------------------------------------------------
  describe('T307: connectVideoService creates notifier when videoEndpoint configured', () => {
    it('creates RPC session to video endpoint on initialize', async () => {
      const config = makeConfig({ videoEndpoint: 'ws://video:4001/api' })
      const svc = new OrchestratorService({ config, telemetry: makeTelemetry() })

      await svc.initialize()

      // newWebSocketRpcSession should have been called with the video endpoint
      const videoCalls = mockNewWebSocketRpcSession.mock.calls.filter(
        (call: unknown[]) => call[0] === 'ws://video:4001/api'
      )
      expect(videoCalls).toHaveLength(1)

      // getVideoClient should have been called with a dispatch capability
      expect(mockGetVideoClient).toHaveBeenCalledOnce()
      const dispatchCapability = mockGetVideoClient.mock.calls[0][0]
      expect(dispatchCapability).toHaveProperty('dispatch')
      expect(typeof dispatchCapability.dispatch).toBe('function')

      await svc.shutdown()
    })

    it('pushes initial catalog after video connection', async () => {
      const config = makeConfig({ videoEndpoint: 'ws://video:4001/api' })
      const svc = new OrchestratorService({ config, telemetry: makeTelemetry() })

      await svc.initialize()

      // pushCurrentCatalog is called during connectVideoService, which calls
      // the notifier's pushCatalog. With an empty route table the catalog
      // should be { streams: [] }.
      expect(mockUpdateStreamCatalog).toHaveBeenCalledOnce()
      expect(mockUpdateStreamCatalog).toHaveBeenCalledWith({ streams: [] })

      await svc.shutdown()
    })

    it('notifier pushes catalog when media route is dispatched', async () => {
      const config = makeConfig({ videoEndpoint: 'ws://video:4001/api' })
      const svc = new OrchestratorService({ config, telemetry: makeTelemetry() })

      await svc.initialize()

      // Clear the initial catalog push
      mockUpdateStreamCatalog.mockClear()

      // Dispatch a media route through the v2 bus
      const { Actions } = await import('@catalyst/routing/v2')
      await svc.v2.bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: 'cam-front', protocol: 'media', endpoint: 'rtsp://localhost:8554/cam-front' },
      })

      expect(mockUpdateStreamCatalog).toHaveBeenCalledOnce()
      const catalog = mockUpdateStreamCatalog.mock.calls[0][0] as StreamCatalog
      expect(catalog.streams).toHaveLength(1)
      expect(catalog.streams[0]).toMatchObject({
        name: 'cam-front',
        protocol: 'media',
        source: 'local',
        sourceNode: 'test-node',
      })

      await svc.shutdown()
    })
  })

  // T308 ----------------------------------------------------------------
  describe('T308: connectVideoService skips when no videoEndpoint', () => {
    it('does not create RPC session when videoEndpoint is absent', async () => {
      const config = makeConfig() // no videoEndpoint
      const svc = new OrchestratorService({ config, telemetry: makeTelemetry() })

      await svc.initialize()

      // newWebSocketRpcSession should NOT have been called with a video endpoint.
      // It may be called for auth if configured, so we check specifically for
      // video-related calls. Since we didn't configure auth either, it shouldn't
      // be called at all.
      expect(mockNewWebSocketRpcSession).not.toHaveBeenCalled()

      await svc.shutdown()
    })

    it('dispatch still works fine without video push', async () => {
      const config = makeConfig() // no videoEndpoint
      const svc = new OrchestratorService({ config, telemetry: makeTelemetry() })

      await svc.initialize()

      const { Actions } = await import('@catalyst/routing/v2')
      const result = await svc.v2.bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: 'api', protocol: 'http', endpoint: 'http://localhost:8080' },
      })

      expect(result.success).toBe(true)
      expect(mockUpdateStreamCatalog).not.toHaveBeenCalled()

      await svc.shutdown()
    })
  })

  // T309 ----------------------------------------------------------------
  describe('T309: token refresh propagates to video connection manager', () => {
    it('calls setNodeToken on video connection manager when mintNodeToken runs', async () => {
      const config = makeConfig({
        videoEndpoint: 'ws://video:4001/api',
        auth: {
          endpoint: 'ws://auth:4000/rpc',
          systemToken: 'system-token',
        },
      })
      const svc = new OrchestratorService({ config, telemetry: makeTelemetry() })

      await svc.initialize()

      const service = svc as unknown as {
        mintNodeToken(): Promise<void>
        _videoConnection: { status: string; setNodeToken: (t: string) => void } | undefined
      }

      // _videoConnection should be set after initialize
      expect(service._videoConnection).toBeDefined()
      expect(service._videoConnection!.status).toBe('connected')

      // Clear mocks to isolate the refresh call
      mockRefreshToken.mockClear()

      // Trigger another mintNodeToken (simulates token refresh)
      await service.mintNodeToken()

      // mintNodeToken calls _videoConnection.setNodeToken() which, while
      // connected, fires refreshToken on the underlying client
      expect(mockRefreshToken).toHaveBeenCalledOnce()
      expect(mockRefreshToken).toHaveBeenCalledWith('minted-node-token')

      await svc.shutdown()
    })
  })

  // T310 ----------------------------------------------------------------
  describe('T310: onShutdown cleans up video state', () => {
    it('stops video connection manager and clears it on shutdown', async () => {
      const config = makeConfig({ videoEndpoint: 'ws://video:4001/api' })
      const svc = new OrchestratorService({ config, telemetry: makeTelemetry() })

      await svc.initialize()

      const service = svc as unknown as {
        _videoConnection: { status: string } | undefined
      }

      // Before shutdown, video connection should be set and connected
      expect(service._videoConnection).toBeDefined()
      expect(service._videoConnection!.status).toBe('connected')

      await svc.shutdown()

      // After shutdown, video connection should be cleared
      expect(service._videoConnection).toBeUndefined()
    })

    it('media route dispatch does not push catalog after shutdown', async () => {
      const config = makeConfig({ videoEndpoint: 'ws://video:4001/api' })
      const svc = new OrchestratorService({ config, telemetry: makeTelemetry() })

      await svc.initialize()
      mockUpdateStreamCatalog.mockClear()

      // Grab the bus reference before shutdown (shutdown calls stop() on v2)
      const bus = svc.v2.bus

      await svc.shutdown()

      // Dispatch a media route after shutdown — the notifier should be cleared
      // so no catalog push should happen
      const { Actions } = await import('@catalyst/routing/v2')
      await bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: 'cam-rear', protocol: 'media' },
      })

      expect(mockUpdateStreamCatalog).not.toHaveBeenCalled()
    })
  })
})
