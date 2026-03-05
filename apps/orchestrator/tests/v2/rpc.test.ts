import { describe, it, expect, beforeEach } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { createNetworkClient, createDataChannelClient, createIBGPClient } from '../../src/v2/rpc.js'
import type { NetworkClient, DataChannel, IBGPClient } from '../../src/v2/rpc.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: OrchestratorConfig = {
  node: {
    name: 'node-a',
    endpoint: 'ws://node-a:4000',
    domains: ['example.local'],
  },
}

const peerInfo: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['example.local'],
}

const routeAlpha = {
  name: 'alpha',
  protocol: 'http' as const,
  endpoint: 'http://alpha:8080',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBus(): OrchestratorBus {
  const transport = new MockPeerTransport()
  return new OrchestratorBus({ config, transport })
}

async function setupPeer(bus: OrchestratorBus): Promise<void> {
  await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
  await bus.dispatch({
    action: Actions.InternalProtocolConnected,
    data: { peerInfo },
  })
}

// ---------------------------------------------------------------------------
// NetworkClient
// ---------------------------------------------------------------------------

describe('createNetworkClient', () => {
  let bus: OrchestratorBus
  let client: NetworkClient

  beforeEach(() => {
    bus = makeBus()
    client = createNetworkClient(bus)
  })

  it('addPeer dispatches LocalPeerCreate and returns success', async () => {
    const result = await client.addPeer(peerInfo)

    expect(result.success).toBe(true)
    expect(bus.state.internal.peers).toHaveLength(1)
    expect(bus.state.internal.peers[0].name).toBe('node-b')
  })

  it('addPeer returns error when peer already exists', async () => {
    await client.addPeer(peerInfo)
    const result = await client.addPeer(peerInfo)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeTruthy()
    }
  })

  it('updatePeer dispatches LocalPeerUpdate and returns success', async () => {
    await client.addPeer(peerInfo)
    const updated = { ...peerInfo, endpoint: 'ws://node-b:5000' }
    const result = await client.updatePeer(updated)

    expect(result.success).toBe(true)
  })

  it('updatePeer returns error when peer does not exist', async () => {
    const result = await client.updatePeer(peerInfo)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeTruthy()
    }
  })

  it('removePeer dispatches LocalPeerDelete and removes from state', async () => {
    await client.addPeer(peerInfo)
    expect(bus.state.internal.peers).toHaveLength(1)

    const result = await client.removePeer({ name: peerInfo.name })

    expect(result.success).toBe(true)
    expect(bus.state.internal.peers).toHaveLength(0)
  })

  it('removePeer returns error when peer does not exist', async () => {
    const result = await client.removePeer({ name: 'nonexistent' })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeTruthy()
    }
  })

  it('listPeers returns current peers from bus state', async () => {
    const before = await client.listPeers()
    expect(before).toHaveLength(0)

    await client.addPeer(peerInfo)
    const after = await client.listPeers()

    expect(after).toHaveLength(1)
    expect(after[0].name).toBe('node-b')
  })
})

// ---------------------------------------------------------------------------
// DataChannel
// ---------------------------------------------------------------------------

describe('createDataChannelClient', () => {
  let bus: OrchestratorBus
  let client: DataChannel

  beforeEach(() => {
    bus = makeBus()
    client = createDataChannelClient(bus)
  })

  it('addRoute dispatches LocalRouteCreate and returns success', async () => {
    const result = await client.addRoute(routeAlpha)

    expect(result.success).toBe(true)
    expect(bus.state.local.routes).toHaveLength(1)
    expect(bus.state.local.routes[0].name).toBe('alpha')
  })

  it('addRoute returns error when route already exists', async () => {
    await client.addRoute(routeAlpha)
    const result = await client.addRoute(routeAlpha)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeTruthy()
    }
  })

  it('removeRoute dispatches LocalRouteDelete and removes from state', async () => {
    await client.addRoute(routeAlpha)
    expect(bus.state.local.routes).toHaveLength(1)

    const result = await client.removeRoute({ name: 'alpha' })

    expect(result.success).toBe(true)
    expect(bus.state.local.routes).toHaveLength(0)
  })

  it('removeRoute returns error when route does not exist', async () => {
    const result = await client.removeRoute({ name: 'nonexistent' })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeTruthy()
    }
  })

  it('listRoutes returns local and internal routes from bus state', async () => {
    const empty = await client.listRoutes()
    expect(empty.local).toHaveLength(0)
    expect(empty.internal).toHaveLength(0)

    await client.addRoute(routeAlpha)
    const withRoute = await client.listRoutes()

    expect(withRoute.local).toHaveLength(1)
    expect(withRoute.local[0].name).toBe('alpha')
    expect(withRoute.internal).toHaveLength(0)
  })

  it('listRoutes reflects internal routes when present', async () => {
    await setupPeer(bus)
    // Dispatch an update so there's an internal route
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: routeAlpha,
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    const result = await client.listRoutes()
    expect(result.internal).toHaveLength(1)
    expect(result.internal[0].name).toBe('alpha')
  })
})

// ---------------------------------------------------------------------------
// IBGPClient
// ---------------------------------------------------------------------------

describe('createIBGPClient', () => {
  let bus: OrchestratorBus
  let client: IBGPClient

  beforeEach(async () => {
    bus = makeBus()
    // Pre-create the peer so protocol actions can succeed
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
    client = createIBGPClient(bus)
  })

  it('open dispatches InternalProtocolOpen and marks peer connected', async () => {
    const result = await client.open({ peerInfo })

    expect(result.success).toBe(true)
    const peer = bus.state.internal.peers.find((p) => p.name === 'node-b')
    expect(peer?.connectionStatus).toBe('connected')
  })

  it('open accepts optional holdTime', async () => {
    const result = await client.open({ peerInfo, holdTime: 30_000 })

    expect(result.success).toBe(true)
  })

  it('open returns error when peer is not pre-configured', async () => {
    const unknownPeer: PeerInfo = { name: 'unknown', endpoint: 'ws://x:4000', domains: [] }
    const result = await client.open({ peerInfo: unknownPeer })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeTruthy()
    }
  })

  it('close dispatches InternalProtocolClose', async () => {
    await client.open({ peerInfo })
    const result = await client.close({ peerInfo, code: 1000, reason: 'test shutdown' })

    expect(result.success).toBe(true)
  })

  it('update dispatches InternalProtocolUpdate', async () => {
    await client.open({ peerInfo })

    const result = await client.update({
      peerInfo,
      update: {
        updates: [
          {
            action: 'add',
            route: routeAlpha,
            nodePath: ['node-b'],
            originNode: 'node-b',
          },
        ],
      },
    })

    expect(result.success).toBe(true)
    expect(bus.state.internal.routes).toHaveLength(1)
  })

  it('keepalive dispatches InternalProtocolKeepalive', async () => {
    await client.open({ peerInfo })
    const result = await client.keepalive({ peerInfo })

    // Keepalive updates lastReceived — state changes so it should succeed
    expect(result.success).toBe(true)
  })
})
