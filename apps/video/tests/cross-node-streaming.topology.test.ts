/**
 * Cross-node video streaming topology test.
 *
 * Proves the full publish → iBGP propagate → relay → withdraw chain
 * using real OrchestratorBus instances with MockPeerTransport (no Docker,
 * no network, no WebSocket). Same pattern as the orchestrator's own
 * topology tests in apps/orchestrator/tests/v2/orchestrator.topology.test.ts.
 *
 * Topology:  Field Node (A) ↔ Command Center (B)
 *
 *   Node A: publishes a camera stream → StreamRouteManager registers route
 *   Node B: RelayManager subscribes via watchRoutes() → creates relay path
 *
 * Each test verifies one link in the chain. Together they prove the full
 * cross-node streaming flow without a single Docker container.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { OrchestratorBus } from '@orchestrator/v2/bus.js'
import { MockPeerTransport, type TransportCall } from '@orchestrator/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '@orchestrator/v1/types.js'
import type { PeerInfo, RouteChange } from '@catalyst/routing/v2'
import { StreamRouteManager } from '../src/routes/stream-route-manager.js'
import { RelayManager } from '../src/routes/relay-manager.js'
import type { ControlApiClient } from '../src/mediamtx/control-api-client.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(name: string): OrchestratorConfig {
  return {
    node: { name, endpoint: `ws://${name}:4000`, domains: ['video.local'] },
  }
}

function makePeerInfo(name: string): PeerInfo {
  return {
    name,
    endpoint: `ws://${name}:4000`,
    domains: ['video.local'],
    peerToken: `token-${name}`,
  }
}

function makeControlApi() {
  return {
    addPath: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    deletePath: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    patchPath: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    listPaths: vi.fn().mockResolvedValue({ ok: true, data: { pageCount: 1, items: [] } }),
    getPath: vi.fn().mockResolvedValue({
      ok: true,
      data: { name: 'cam-front', tracks: ['H264'], source: { type: 'rtspSession' } },
    }),
  }
}

// ---------------------------------------------------------------------------
// Topology helper (simplified from orchestrator's version)
// ---------------------------------------------------------------------------

interface NodeEntry {
  name: string
  bus: OrchestratorBus
  transport: MockPeerTransport
  peerInfo: PeerInfo
}

class VideoTopology {
  private nodes = new Map<string, NodeEntry>()

  addNode(name: string): NodeEntry {
    const transport = new MockPeerTransport()
    const config = makeConfig(name)
    const bus = new OrchestratorBus({ config, transport })
    const entry: NodeEntry = { name, bus, transport, peerInfo: makePeerInfo(name) }
    this.nodes.set(name, entry)
    return entry
  }

  get(name: string): NodeEntry {
    const n = this.nodes.get(name)
    if (!n) throw new Error(`Unknown node: ${name}`)
    return n
  }

  async peer(a: string, b: string): Promise<void> {
    const na = this.get(a)
    const nb = this.get(b)
    await na.bus.dispatch({ action: Actions.LocalPeerCreate, data: nb.peerInfo })
    await nb.bus.dispatch({ action: Actions.LocalPeerCreate, data: na.peerInfo })
    await na.bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: nb.peerInfo },
    })
    await nb.bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: na.peerInfo },
    })
  }

  async propagate(from: string, to: string): Promise<void> {
    const f = this.get(from)
    const t = this.get(to)

    const consumed: TransportCall[] = []
    const remaining: TransportCall[] = []
    for (const call of f.transport.calls) {
      if (call.method === 'sendUpdate' && call.peer.name === to) consumed.push(call)
      else remaining.push(call)
    }
    f.transport.calls.length = 0
    for (const c of remaining) f.transport.calls.push(c)

    for (const call of consumed) {
      if (call.method !== 'sendUpdate') continue
      await t.bus.dispatch({
        action: Actions.InternalProtocolUpdate,
        data: { peerInfo: f.peerInfo, update: call.message },
      })
    }
  }

  resetAll(): void {
    for (const entry of this.nodes.values()) entry.transport.reset()
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cross-node video streaming: Field Node A ↔ Command Center B', () => {
  let topo: VideoTopology
  let _controlApiA: ReturnType<typeof makeControlApi>
  let controlApiB: ReturnType<typeof makeControlApi>
  let routeManagerA: StreamRouteManager
  let relayManagerB: RelayManager
  let routeChangesB: RouteChange[]

  beforeEach(async () => {
    topo = new VideoTopology()
    topo.addNode('field-a.video.local')
    topo.addNode('cmd-b.video.local')
    await topo.peer('field-a.video.local', 'cmd-b.video.local')
    topo.resetAll()

    _controlApiA = makeControlApi()
    controlApiB = makeControlApi()
    routeChangesB = []

    // StreamRouteManager on Node A — publishes routes to A's orchestrator
    routeManagerA = new StreamRouteManager({
      registrar: {
        addRoute: async (route) => {
          const result = await topo.get('field-a.video.local').bus.dispatch({
            action: Actions.LocalRouteCreate,
            data: route,
          })
          if (!result.success) throw new Error(result.error)
        },
        removeRoute: async (name) => {
          const result = await topo.get('field-a.video.local').bus.dispatch({
            action: Actions.LocalRouteDelete,
            data: { name },
          })
          if (!result.success) throw new Error(result.error)
        },
      },
      metadataProvider: {
        getPathMetadata: async () => ({
          tracks: ['H264'],
          sourceType: 'rtspSession',
        }),
      },
      advertiseAddress: '10.0.1.5',
      rtspPort: 8554,
      maxStreams: 16,
      debounceMs: 0, // no debounce in tests
    })

    // Subscribe to route changes on Node B's bus (same as DataChannel.watchRoutes)
    topo.get('cmd-b.video.local').bus.subscribeRouteChanges((changes) => {
      routeChangesB.push(...changes)
    })

    // RelayManager on Node B — creates relay paths when remote routes arrive
    relayManagerB = new RelayManager({
      routeSource: {
        watchRoutes: (cb) => {
          return topo.get('cmd-b.video.local').bus.subscribeRouteChanges(cb)
        },
        listRoutes: async () => {
          const state = topo.get('cmd-b.video.local').bus.state
          return {
            local: state.local.routes,
            internal: state.internal.routes,
          }
        },
      },
      controlApi: controlApiB as unknown as ControlApiClient,
      localNodeName: 'cmd-b.video.local',
      getRelayToken: () => 'jwt-data-custodian-token',
    })
    await relayManagerB.start()
  })

  // -----------------------------------------------------------------------
  // Step 1: Publish on Node A
  // -----------------------------------------------------------------------

  it("camera publish on Node A registers a media route in A's routing table", async () => {
    await routeManagerA.handleReady('cam-front', {
      sourceType: 'rtspSession',
      sourceId: 'session-1',
    })

    const stateA = topo.get('field-a.video.local').bus.state
    const route = stateA.local.routes.find((r) => r.name === 'cam-front')
    expect(route).toBeDefined()
    expect(route!.protocol).toBe('media')
    expect(route!.endpoint).toBe('rtsp://10.0.1.5:8554/cam-front')
    expect(route!.tags).toContain('track:H264')
    expect(route!.tags).toContain('source-type:rtspSession')
  })

  // -----------------------------------------------------------------------
  // Step 2: iBGP propagation A → B
  // -----------------------------------------------------------------------

  it('media route propagates from Node A to Node B via iBGP', async () => {
    await routeManagerA.handleReady('cam-front', {
      sourceType: 'rtspSession',
      sourceId: 'session-1',
    })

    await topo.propagate('field-a.video.local', 'cmd-b.video.local')

    const stateB = topo.get('cmd-b.video.local').bus.state
    const route = stateB.internal.routes.find((r) => r.name === 'cam-front')
    expect(route).toBeDefined()
    expect(route!.protocol).toBe('media')
    expect(route!.originNode).toBe('field-a.video.local')
    expect(route!.endpoint).toBe('rtsp://10.0.1.5:8554/cam-front')
  })

  // -----------------------------------------------------------------------
  // Step 3: Relay manager on B creates on-demand relay
  // -----------------------------------------------------------------------

  it('Node B relay manager creates on-demand relay path when route arrives', async () => {
    await routeManagerA.handleReady('cam-front', {
      sourceType: 'rtspSession',
      sourceId: 'session-1',
    })
    await topo.propagate('field-a.video.local', 'cmd-b.video.local')

    // RelayManager received the change via watchRoutes subscription
    expect(routeChangesB.length).toBeGreaterThanOrEqual(1)
    expect(routeChangesB[0].type).toBe('added')
    expect(routeChangesB[0].route.name).toBe('cam-front')

    // Wait for fire-and-forget addRelay to settle
    await vi.waitFor(() => expect(controlApiB.addPath).toHaveBeenCalled())

    expect(controlApiB.addPath).toHaveBeenCalledWith(
      'cam-front',
      expect.objectContaining({
        source: 'rtsp://10.0.1.5:8554/cam-front',
        sourceOnDemand: true,
        sourceUser: 'relay',
        sourcePass: 'jwt-data-custodian-token',
      })
    )
    expect(relayManagerB.relayCount).toBe(1)
  })

  // -----------------------------------------------------------------------
  // Step 4: Camera disconnect → route withdrawal → relay teardown
  // -----------------------------------------------------------------------

  it('camera disconnect on A withdraws route and tears down relay on B', async () => {
    // Publish
    await routeManagerA.handleReady('cam-front', {
      sourceType: 'rtspSession',
      sourceId: 'session-1',
    })
    await topo.propagate('field-a.video.local', 'cmd-b.video.local')
    await vi.waitFor(() => expect(controlApiB.addPath).toHaveBeenCalled())
    topo.resetAll()

    // Disconnect
    await routeManagerA.handleNotReady('cam-front')
    await topo.propagate('field-a.video.local', 'cmd-b.video.local')

    // Relay manager should remove the relay path
    await vi.waitFor(() => expect(controlApiB.deletePath).toHaveBeenCalled())
    expect(controlApiB.deletePath).toHaveBeenCalledWith('cam-front')
    expect(relayManagerB.relayCount).toBe(0)

    // Route gone from both nodes
    const stateA = topo.get('field-a.video.local').bus.state
    const stateB = topo.get('cmd-b.video.local').bus.state
    expect(stateA.local.routes.find((r) => r.name === 'cam-front')).toBeUndefined()
    expect(stateB.internal.routes.find((r) => r.name === 'cam-front')).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // Step 5: Multiple streams
  // -----------------------------------------------------------------------

  it('multiple cameras on A each get relayed on B', async () => {
    await routeManagerA.handleReady('cam-front', {
      sourceType: 'rtspSession',
      sourceId: 's1',
    })
    await routeManagerA.handleReady('cam-rear', {
      sourceType: 'rtspSession',
      sourceId: 's2',
    })
    await topo.propagate('field-a.video.local', 'cmd-b.video.local')

    await vi.waitFor(() => expect(controlApiB.addPath).toHaveBeenCalledTimes(2))

    expect(relayManagerB.relayCount).toBe(2)
    expect(controlApiB.addPath).toHaveBeenCalledWith('cam-front', expect.anything())
    expect(controlApiB.addPath).toHaveBeenCalledWith('cam-rear', expect.anything())
  })

  // -----------------------------------------------------------------------
  // Step 6: Node B ignores its own local routes (no self-relay)
  // -----------------------------------------------------------------------

  it('Node B does not create a relay for its own local routes', async () => {
    // B publishes a local stream
    await topo.get('cmd-b.video.local').bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: {
        name: 'local-cam',
        protocol: 'media' as const,
        endpoint: 'rtsp://cmd-b.video.local:8554/local-cam',
      },
    })

    // The route change fires but relay manager should skip it (local origin)
    await new Promise((r) => setTimeout(r, 50))
    expect(controlApiB.addPath).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // Step 7: Auth hook enforcement (inline — no container needed)
  // -----------------------------------------------------------------------

  it('auth hook allows localhost publish, denies remote, denies tokenless read', async () => {
    // Import dynamically to avoid pulling in Hono deps at module level
    const { createAuthHook } = await import('../src/hooks/auth.js')

    const authHook = createAuthHook({
      tokenValidator: {
        validate: async () => ({ valid: false, error: 'no auth service in test' }),
      },
      streamAccess: { evaluate: () => 'allow' },
      nodeId: 'field-a.video.local',
      domainId: 'video.local',
    })

    // Localhost publish → 200
    const pub = await authHook.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'publish',
        ip: '127.0.0.1',
        path: 'cam-front',
        protocol: 'rtsp',
        id: 'sess-1',
      }),
    })
    expect(pub.status).toBe(200)

    // Remote publish → 403
    const remotePub = await authHook.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'publish',
        ip: '10.0.0.5',
        path: 'cam-front',
        protocol: 'rtsp',
        id: 'sess-2',
      }),
    })
    expect(remotePub.status).toBe(403)

    // Read without token → 401
    const noTokenRead = await authHook.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'read',
        ip: '10.0.0.100',
        path: 'cam-front',
        protocol: 'rtsp',
        id: 'sess-3',
      }),
    })
    expect(noTokenRead.status).toBe(401)
  })

  // -----------------------------------------------------------------------
  // Step 8: SSRF validation blocks dangerous endpoints
  // -----------------------------------------------------------------------

  it('relay manager rejects routes with metadata IP endpoints', async () => {
    // Inject a route with a metadata IP directly into B's bus
    await topo.get('field-a.video.local').bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: {
        name: 'evil-stream',
        protocol: 'media' as const,
        endpoint: 'rtsp://169.254.169.254:8554/latest/meta-data',
      },
    })
    await topo.propagate('field-a.video.local', 'cmd-b.video.local')

    // Relay manager should NOT create a path for this
    await new Promise((r) => setTimeout(r, 50))
    expect(controlApiB.addPath).not.toHaveBeenCalled()
    expect(relayManagerB.relayCount).toBe(0)
  })
})
