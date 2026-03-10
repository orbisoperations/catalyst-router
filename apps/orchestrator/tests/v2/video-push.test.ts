import { describe, it, expect, beforeEach, vi } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'
import type { VideoNotifier } from '../../src/v2/video-notifier.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const configA: OrchestratorConfig = {
  node: {
    name: 'node-a',
    endpoint: 'ws://node-a:4000',
    domains: ['example.local'],
  },
}

const peerBInfo: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['example.local'],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockNotifier(): VideoNotifier & { pushCatalog: ReturnType<typeof vi.fn> } {
  return { pushCatalog: vi.fn().mockResolvedValue(undefined) }
}

async function connectPeer(bus: OrchestratorBus, peerInfo: PeerInfo): Promise<void> {
  await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
  await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo } })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Video push — post-commit notification', () => {
  let transport: MockPeerTransport
  let notifier: ReturnType<typeof makeMockNotifier>
  let bus: OrchestratorBus

  beforeEach(() => {
    transport = new MockPeerTransport()
    notifier = makeMockNotifier()
    bus = new OrchestratorBus({ config: configA, transport, videoNotifier: notifier })
  })

  it('pushes catalog after media route creation', async () => {
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'cam-front', protocol: 'media', endpoint: 'rtsp://localhost:8554/cam-front' },
    })

    expect(notifier.pushCatalog).toHaveBeenCalledOnce()
    expect(notifier.pushCatalog).toHaveBeenCalledWith({
      streams: [
        {
          name: 'cam-front',
          protocol: 'media',
          endpoint: 'rtsp://localhost:8554/cam-front',
          source: 'local',
          sourceNode: 'node-a',
        },
      ],
    })
  })

  it('does NOT push catalog for non-media route creation', async () => {
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'api', protocol: 'http', endpoint: 'http://localhost:8080' },
    })

    expect(notifier.pushCatalog).not.toHaveBeenCalled()
  })

  it('pushes { streams: [] } after last media route is removed', async () => {
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'cam-front', protocol: 'media' },
    })
    notifier.pushCatalog.mockClear()

    await bus.dispatch({
      action: Actions.LocalRouteDelete,
      data: { name: 'cam-front', protocol: 'media' },
    })

    expect(notifier.pushCatalog).toHaveBeenCalledWith({ streams: [] })
  })

  it('pushes catalog with remote stream after InternalProtocolUpdate', async () => {
    await connectPeer(bus, peerBInfo)
    notifier.pushCatalog.mockClear()

    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerBInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: {
                name: 'cam-rear',
                protocol: 'media',
                endpoint: 'rtsp://node-b:8554/cam-rear',
              },
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    expect(notifier.pushCatalog).toHaveBeenCalledOnce()
    const catalog = notifier.pushCatalog.mock.calls[0][0]
    expect(catalog.streams).toContainEqual(
      expect.objectContaining({
        name: 'cam-rear',
        source: 'remote',
        sourceNode: 'node-b',
        nodePath: ['node-b'],
      })
    )
  })

  it('dispatch succeeds even when notifier throws', async () => {
    notifier.pushCatalog.mockRejectedValue(new Error('RPC disconnected'))

    const result = await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'cam-front', protocol: 'media' },
    })

    expect(result.success).toBe(true)
  })

  it('pushes catalog once per dispatch even under rapid succession', async () => {
    await Promise.all([
      bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: 'cam-front', protocol: 'media' },
      }),
      bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: 'cam-rear', protocol: 'media' },
      }),
    ])

    expect(notifier.pushCatalog).toHaveBeenCalledTimes(2)
  })

  it('does NOT push catalog for peer HTTP-only route update', async () => {
    await connectPeer(bus, peerBInfo)
    notifier.pushCatalog.mockClear()

    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerBInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'api', protocol: 'http', endpoint: 'http://node-b:8080' },
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    expect(notifier.pushCatalog).not.toHaveBeenCalled()
  })

  it('does NOT push for Tick with no media route changes', async () => {
    await bus.dispatch({
      action: Actions.Tick,
      data: { now: Date.now() },
    })

    expect(notifier.pushCatalog).not.toHaveBeenCalled()
  })

  it('pushes catalog when peer close removes media routes', async () => {
    await connectPeer(bus, peerBInfo)

    // Receive a media route from peerB
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerBInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'cam-rear', protocol: 'media' },
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })
    notifier.pushCatalog.mockClear()

    // Close the peer — routes should be removed
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: peerBInfo, code: 1000 },
    })

    expect(notifier.pushCatalog).toHaveBeenCalledOnce()
    const catalog = notifier.pushCatalog.mock.calls[0][0]
    expect(catalog.streams.find((s: { name: string }) => s.name === 'cam-rear')).toBeUndefined()
  })
})

describe('Video push — no notifier configured', () => {
  it('dispatch works without video notifier', async () => {
    const transport = new MockPeerTransport()
    const bus = new OrchestratorBus({ config: configA, transport })

    const result = await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'cam-front', protocol: 'media' },
    })

    expect(result.success).toBe(true)
  })
})

describe('Video push — pushCurrentCatalog()', () => {
  it('pushes full catalog from current state', async () => {
    const transport = new MockPeerTransport()
    const notifier = makeMockNotifier()
    const bus = new OrchestratorBus({ config: configA, transport })

    // Create some media routes
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'cam-front', protocol: 'media' },
    })
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'cam-rear', protocol: 'media' },
    })

    // Set notifier after routes exist (simulates late video connection)
    bus.setVideoNotifier(notifier)
    await bus.pushCurrentCatalog()

    expect(notifier.pushCatalog).toHaveBeenCalledOnce()
    const catalog = notifier.pushCatalog.mock.calls[0][0]
    expect(catalog.streams).toHaveLength(2)
    expect(catalog.streams.map((s: { name: string }) => s.name).sort()).toEqual([
      'cam-front',
      'cam-rear',
    ])
  })

  it('pushes { streams: [] } when no media routes exist', async () => {
    const transport = new MockPeerTransport()
    const notifier = makeMockNotifier()
    const bus = new OrchestratorBus({ config: configA, transport })

    bus.setVideoNotifier(notifier)
    await bus.pushCurrentCatalog()

    expect(notifier.pushCatalog).toHaveBeenCalledOnce()
    expect(notifier.pushCatalog).toHaveBeenCalledWith({ streams: [] })
  })

  it('does not throw when no notifier is set', async () => {
    const transport = new MockPeerTransport()
    const bus = new OrchestratorBus({ config: configA, transport })

    await expect(bus.pushCurrentCatalog()).resolves.not.toThrow()
  })
})
