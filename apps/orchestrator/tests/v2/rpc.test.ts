import { describe, it, expect, beforeEach } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { createNetworkClient, createDataChannelClient, createIBGPClient } from '../../src/v2/rpc.js'
import type { TokenValidator } from '../../src/v2/rpc.js'
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

const VALID_TOKEN = 'valid-test-token'
const INVALID_TOKEN = 'invalid-token'

// ---------------------------------------------------------------------------
// Mock validators
// ---------------------------------------------------------------------------

const allowAllValidator: TokenValidator = {
  async validateToken() {
    return { valid: true }
  },
}

function rejectingValidator(expectedAction?: string): TokenValidator {
  return {
    async validateToken(_token: string, action: string) {
      if (expectedAction && action !== expectedAction) {
        return { valid: true }
      }
      return { valid: false, error: 'Permission denied' }
    },
  }
}

function tokenCheckingValidator(validToken: string): TokenValidator {
  return {
    async validateToken(token: string) {
      if (token === validToken) {
        return { valid: true }
      }
      return { valid: false, error: 'Invalid token' }
    },
  }
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
// Token validation (shared across all factories)
// ---------------------------------------------------------------------------

describe('RPC token validation', () => {
  let bus: OrchestratorBus

  beforeEach(() => {
    bus = makeBus()
  })

  it('createNetworkClient rejects invalid token', async () => {
    const result = await createNetworkClient(
      bus,
      INVALID_TOKEN,
      tokenCheckingValidator(VALID_TOKEN)
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Invalid token')
    }
  })

  it('createDataChannelClient rejects invalid token', async () => {
    const result = await createDataChannelClient(
      bus,
      INVALID_TOKEN,
      tokenCheckingValidator(VALID_TOKEN)
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Invalid token')
    }
  })

  it('createIBGPClient rejects invalid token', async () => {
    const result = await createIBGPClient(bus, INVALID_TOKEN, tokenCheckingValidator(VALID_TOKEN))

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Invalid token')
    }
  })

  it('createNetworkClient validates against PEER_CREATE action', async () => {
    const result = await createNetworkClient(bus, VALID_TOKEN, rejectingValidator('PEER_CREATE'))

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Permission denied')
    }
  })

  it('createDataChannelClient validates against ROUTE_CREATE action', async () => {
    const result = await createDataChannelClient(
      bus,
      VALID_TOKEN,
      rejectingValidator('ROUTE_CREATE')
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Permission denied')
    }
  })

  it('createIBGPClient validates against IBGP_CONNECT action', async () => {
    const result = await createIBGPClient(bus, VALID_TOKEN, rejectingValidator('IBGP_CONNECT'))

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Permission denied')
    }
  })
})

// ---------------------------------------------------------------------------
// NetworkClient
// ---------------------------------------------------------------------------

describe('createNetworkClient', () => {
  let bus: OrchestratorBus

  beforeEach(() => {
    bus = makeBus()
  })

  it('addPeer dispatches LocalPeerCreate and returns success', async () => {
    const result = await createNetworkClient(bus, VALID_TOKEN, allowAllValidator)
    expect(result.success).toBe(true)
    if (!result.success) return

    const addResult = await result.client.addPeer(peerInfo)
    expect(addResult.success).toBe(true)
    expect(bus.state.internal.peers).toHaveLength(1)
    expect(bus.state.internal.peers[0].name).toBe('node-b')
  })

  it('addPeer returns error when peer already exists', async () => {
    const result = await createNetworkClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    await result.client.addPeer(peerInfo)
    const addResult = await result.client.addPeer(peerInfo)

    expect(addResult.success).toBe(false)
    if (!addResult.success) {
      expect(addResult.error).toBeTruthy()
    }
  })

  it('updatePeer dispatches LocalPeerUpdate and returns success', async () => {
    const result = await createNetworkClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    await result.client.addPeer(peerInfo)
    const updated = { ...peerInfo, endpoint: 'ws://node-b:5000' }
    const updateResult = await result.client.updatePeer(updated)

    expect(updateResult.success).toBe(true)
  })

  it('updatePeer returns error when peer does not exist', async () => {
    const result = await createNetworkClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    const updateResult = await result.client.updatePeer(peerInfo)

    expect(updateResult.success).toBe(false)
    if (!updateResult.success) {
      expect(updateResult.error).toBeTruthy()
    }
  })

  it('removePeer dispatches LocalPeerDelete and removes from state', async () => {
    const result = await createNetworkClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    await result.client.addPeer(peerInfo)
    expect(bus.state.internal.peers).toHaveLength(1)

    const removeResult = await result.client.removePeer({ name: peerInfo.name })

    expect(removeResult.success).toBe(true)
    expect(bus.state.internal.peers).toHaveLength(0)
  })

  it('removePeer returns error when peer does not exist', async () => {
    const result = await createNetworkClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    const removeResult = await result.client.removePeer({ name: 'nonexistent' })

    expect(removeResult.success).toBe(false)
    if (!removeResult.success) {
      expect(removeResult.error).toBeTruthy()
    }
  })

  it('listPeers returns current peers from bus state', async () => {
    const result = await createNetworkClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    const before = await result.client.listPeers()
    expect(before).toHaveLength(0)

    await result.client.addPeer(peerInfo)
    const after = await result.client.listPeers()

    expect(after).toHaveLength(1)
    expect(after[0].name).toBe('node-b')
  })
})

// ---------------------------------------------------------------------------
// DataChannel
// ---------------------------------------------------------------------------

describe('createDataChannelClient', () => {
  let bus: OrchestratorBus

  beforeEach(() => {
    bus = makeBus()
  })

  it('addRoute dispatches LocalRouteCreate and returns success', async () => {
    const result = await createDataChannelClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    const addResult = await result.client.addRoute(routeAlpha)
    expect(addResult.success).toBe(true)
    expect(bus.state.local.routes).toHaveLength(1)
    expect(bus.state.local.routes[0].name).toBe('alpha')
  })

  it('addRoute returns error when route already exists', async () => {
    const result = await createDataChannelClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    await result.client.addRoute(routeAlpha)
    const addResult = await result.client.addRoute(routeAlpha)

    expect(addResult.success).toBe(false)
    if (!addResult.success) {
      expect(addResult.error).toBeTruthy()
    }
  })

  it('removeRoute dispatches LocalRouteDelete and removes from state', async () => {
    const result = await createDataChannelClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    await result.client.addRoute(routeAlpha)
    expect(bus.state.local.routes).toHaveLength(1)

    const removeResult = await result.client.removeRoute({ name: 'alpha' })

    expect(removeResult.success).toBe(true)
    expect(bus.state.local.routes).toHaveLength(0)
  })

  it('removeRoute returns error when route does not exist', async () => {
    const result = await createDataChannelClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    const removeResult = await result.client.removeRoute({ name: 'nonexistent' })

    expect(removeResult.success).toBe(false)
    if (!removeResult.success) {
      expect(removeResult.error).toBeTruthy()
    }
  })

  it('listRoutes returns local and internal routes from bus state', async () => {
    const result = await createDataChannelClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    const empty = await result.client.listRoutes()
    expect(empty.local).toHaveLength(0)
    expect(empty.internal).toHaveLength(0)

    await result.client.addRoute(routeAlpha)
    const withRoute = await result.client.listRoutes()

    expect(withRoute.local).toHaveLength(1)
    expect(withRoute.local[0].name).toBe('alpha')
    expect(withRoute.internal).toHaveLength(0)
  })

  it('listRoutes reflects internal routes when present', async () => {
    await setupPeer(bus)
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

    const result = await createDataChannelClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    const routes = await result.client.listRoutes()
    expect(routes.internal).toHaveLength(1)
    expect(routes.internal[0].name).toBe('alpha')
  })
})

// ---------------------------------------------------------------------------
// IBGPClient
// ---------------------------------------------------------------------------

describe('createIBGPClient', () => {
  let bus: OrchestratorBus

  beforeEach(async () => {
    bus = makeBus()
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
  })

  it('open dispatches InternalProtocolOpen and marks peer connected', async () => {
    const result = await createIBGPClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    const openResult = await result.client.open({ peerInfo })
    expect(openResult.success).toBe(true)

    const peer = bus.state.internal.peers.find((p) => p.name === 'node-b')
    expect(peer?.connectionStatus).toBe('connected')
  })

  it('open accepts optional holdTime', async () => {
    const result = await createIBGPClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    const openResult = await result.client.open({ peerInfo, holdTime: 30_000 })
    expect(openResult.success).toBe(true)
  })

  it('open returns error when peer is not pre-configured', async () => {
    const result = await createIBGPClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    const unknownPeer: PeerInfo = { name: 'unknown', endpoint: 'ws://x:4000', domains: [] }
    const openResult = await result.client.open({ peerInfo: unknownPeer })

    expect(openResult.success).toBe(false)
    if (!openResult.success) {
      expect(openResult.error).toBeTruthy()
    }
  })

  it('close dispatches InternalProtocolClose', async () => {
    const result = await createIBGPClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    await result.client.open({ peerInfo })
    const closeResult = await result.client.close({ peerInfo, code: 1000, reason: 'test shutdown' })
    expect(closeResult.success).toBe(true)
  })

  it('update dispatches InternalProtocolUpdate', async () => {
    const result = await createIBGPClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    await result.client.open({ peerInfo })
    const updateResult = await result.client.update({
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

    expect(updateResult.success).toBe(true)
    expect(bus.state.internal.routes).toHaveLength(1)
  })

  it('keepalive dispatches InternalProtocolKeepalive', async () => {
    const result = await createIBGPClient(bus, VALID_TOKEN, allowAllValidator)
    if (!result.success) return

    await result.client.open({ peerInfo })
    const keepaliveResult = await result.client.keepalive({ peerInfo })
    expect(keepaliveResult.success).toBe(true)
  })
})
