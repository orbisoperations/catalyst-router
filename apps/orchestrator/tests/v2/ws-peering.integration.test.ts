/**
 * WebSocket integration tests for v2 orchestrator peering.
 *
 * Unlike the unit tests (which use MockPeerTransport), these tests start real
 * Hono servers with capnweb RPC endpoints and connect them via WebSocketPeerTransport.
 * This validates the full dispatch pipeline: RPC → bus → RIB → transport → wire.
 *
 * Uses port: 0 for dynamic port allocation. No auth service dependency (allowAllValidator).
 *
 * Key concept: peerToken on a PeerRecord is the LOCAL node's JWT used to authenticate
 * with that REMOTE peer. When Node A creates peer B, peerToken = tokenA.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Hono } from 'hono'
import { newRpcResponse } from '@hono/capnweb'
import { SignJWT } from 'jose'
import { catalystHonoServer, getUpgradeWebSocket } from '@catalyst/service'
import type { CatalystHonoServer } from '@catalyst/service'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { WebSocketPeerTransport } from '../../src/v2/ws-transport.js'
import { createNetworkClient, createDataChannelClient, createIBGPClient } from '../../src/v2/rpc.js'
import type { TokenValidator } from '../../src/v2/rpc.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET = new TextEncoder().encode('test-secret-for-ws-integration')

const allowAllValidator: TokenValidator = {
  async validateToken() {
    return { valid: true }
  },
}

async function makeJwt(sub: string): Promise<string> {
  return new SignJWT({ sub }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().sign(TEST_SECRET)
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timeout after ${timeoutMs}ms waiting for convergence`)
}

// ---------------------------------------------------------------------------
// Test node — lightweight orchestrator with real WebSocket server
// ---------------------------------------------------------------------------

interface TestNode {
  name: string
  token: string
  config: OrchestratorConfig
  bus: OrchestratorBus
  transport: WebSocketPeerTransport
  server: CatalystHonoServer
  port: number
  endpoint: string
}

async function createTestNode(name: string): Promise<TestNode> {
  const token = await makeJwt(name)

  const transport = new WebSocketPeerTransport({
    localNodeInfo: { name, domains: ['ws-test.local'] },
  })

  const config: OrchestratorConfig = {
    node: { name, endpoint: `ws://localhost:0/rpc`, domains: ['ws-test.local'] },
  }

  const bus = new OrchestratorBus({
    config,
    transport,
    nodeToken: token,
  })

  const app = new Hono()
  app.all('/rpc', (c) => {
    return newRpcResponse(
      c,
      {
        getNetworkClient: (t: string) => createNetworkClient(bus, t, allowAllValidator),
        getDataChannelClient: (t: string) => createDataChannelClient(bus, t, allowAllValidator),
        getIBGPClient: (t: string) => createIBGPClient(bus, t, allowAllValidator),
      },
      { upgradeWebSocket: getUpgradeWebSocket(c) }
    )
  })

  const server = catalystHonoServer(app, { port: 0 })
  await server.start()
  const port = server.port
  const endpoint = `ws://localhost:${port}/rpc`

  config.node.endpoint = endpoint

  return { name, token, config, bus, transport, server, port, endpoint }
}

async function stopNode(node: TestNode): Promise<void> {
  // Race server.stop() against a timeout — capnweb WebSocket connections
  // can hold the server open past the default hook timeout.
  await Promise.race([node.server.stop(), new Promise<void>((r) => setTimeout(r, 2_000))])
}

/**
 * Establish bidirectional peering between two test nodes.
 * Each node adds the other as a peer with the correct peerToken,
 * then dials the other via WebSocket and dispatches InternalProtocolConnected.
 */
async function peerNodes(a: TestNode, b: TestNode): Promise<void> {
  // Each node adds the other as a peer.
  // peerToken = the LOCAL node's JWT (used to authenticate with the remote).
  const peerBOnA: PeerInfo = {
    name: b.name,
    endpoint: b.endpoint,
    domains: ['ws-test.local'],
    peerToken: a.token,
  }
  const peerAOnB: PeerInfo = {
    name: a.name,
    endpoint: a.endpoint,
    domains: ['ws-test.local'],
    peerToken: b.token,
  }

  await a.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerBOnA })
  await b.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerAOnB })

  // A dials B
  await a.transport.openPeer(
    {
      ...peerBOnA,
      connectionStatus: 'initializing',
      lastConnected: 0,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 0,
    },
    a.token
  )

  // Wait for B to see A as connected (via InternalProtocolOpen from A's dial)
  await waitFor(() => {
    const p = b.bus.state.internal.peers.find((pp) => pp.name === a.name)
    return p?.connectionStatus === 'connected'
  })

  // A marks its side as connected → triggers initial sync A→B
  await a.bus.dispatch({
    action: Actions.InternalProtocolConnected,
    data: { peerInfo: peerBOnA },
  })

  // B dials A
  await b.transport.openPeer(
    {
      ...peerAOnB,
      connectionStatus: 'initializing',
      lastConnected: 0,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 0,
    },
    b.token
  )

  // Wait for A to see B's inbound dial
  await waitFor(() => {
    const p = a.bus.state.internal.peers.find((pp) => pp.name === b.name)
    return p?.connectionStatus === 'connected'
  })

  // B marks its side as connected → triggers initial sync B→A
  await b.bus.dispatch({
    action: Actions.InternalProtocolConnected,
    data: { peerInfo: peerAOnB },
  })
}

// ---------------------------------------------------------------------------
// Group 1: WebSocketPeerTransport — connection lifecycle
// ---------------------------------------------------------------------------

describe('WebSocketPeerTransport: connection lifecycle', () => {
  let serverNode: TestNode

  beforeAll(async () => {
    serverNode = await createTestNode('node-b')
  })

  afterAll(async () => {
    await stopNode(serverNode)
  })

  it('openPeer establishes an iBGP session via WebSocket RPC', async () => {
    const tokenA = await makeJwt('node-a')
    const peerA: PeerInfo = {
      name: 'node-a',
      endpoint: 'ws://localhost:0/rpc',
      domains: ['ws-test.local'],
      peerToken: tokenA,
    }
    await serverNode.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerA })

    const transportA = new WebSocketPeerTransport({
      localNodeInfo: { name: 'node-a', domains: ['ws-test.local'] },
    })
    const peerRecord = {
      name: 'node-b',
      endpoint: serverNode.endpoint,
      domains: ['ws-test.local'],
      connectionStatus: 'initializing' as const,
      lastConnected: 0,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 0,
    }

    await transportA.openPeer(peerRecord, tokenA)

    await waitFor(() => {
      const peer = serverNode.bus.state.internal.peers.find((p) => p.name === 'node-a')
      return peer?.connectionStatus === 'connected'
    })

    const peerOnB = serverNode.bus.state.internal.peers.find((p) => p.name === 'node-a')
    expect(peerOnB?.connectionStatus).toBe('connected')
  })

  it('openPeer throws when server is unreachable', async () => {
    const transport = new WebSocketPeerTransport({
      localNodeInfo: { name: 'node-lonely', domains: ['ws-test.local'] },
    })

    const peerRecord = {
      name: 'node-ghost',
      endpoint: 'ws://localhost:19999/rpc',
      domains: ['ws-test.local'],
      connectionStatus: 'initializing' as const,
      lastConnected: 0,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 0,
    }

    await expect(transport.openPeer(peerRecord, 'any-token')).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Group 2: Two-node bidirectional peering over real WebSocket
// ---------------------------------------------------------------------------

describe('Two-node WebSocket peering', () => {
  let nodeA: TestNode
  let nodeB: TestNode

  beforeAll(async () => {
    nodeA = await createTestNode('node-alpha')
    nodeB = await createTestNode('node-beta')
  })

  afterAll(async () => {
    await stopNode(nodeA)
    await stopNode(nodeB)
  })

  it('two nodes peer and exchange routes over WebSocket', async () => {
    // Establish bidirectional peering
    await peerNodes(nodeA, nodeB)

    // Add local routes to each node
    await nodeA.bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'service-alpha', protocol: 'http', endpoint: 'http://svc-a:8080' },
    })
    await nodeB.bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'service-beta', protocol: 'http', endpoint: 'http://svc-b:8080' },
    })

    // Wait for routes to propagate via delta fan-out (post-commit side effect)
    await waitFor(() => {
      const bHasA = nodeB.bus.state.internal.routes.some((r) => r.name === 'service-alpha')
      const aHasB = nodeA.bus.state.internal.routes.some((r) => r.name === 'service-beta')
      return bHasA && aHasB
    })

    expect(nodeB.bus.state.internal.routes.some((r) => r.name === 'service-alpha')).toBe(true)
    expect(nodeA.bus.state.internal.routes.some((r) => r.name === 'service-beta')).toBe(true)

    // Verify route attribution
    const routeOnB = nodeB.bus.state.internal.routes.find((r) => r.name === 'service-alpha')!
    expect(routeOnB.originNode).toBe('node-alpha')
    expect(routeOnB.nodePath).toContain('node-alpha')
  })

  it('route withdrawal propagates over WebSocket — no zombie routes', async () => {
    // Verify service-alpha exists on B
    expect(nodeB.bus.state.internal.routes.some((r) => r.name === 'service-alpha')).toBe(true)

    // Delete service-alpha from node-alpha
    await nodeA.bus.dispatch({
      action: Actions.LocalRouteDelete,
      data: { name: 'service-alpha', protocol: 'http', endpoint: 'http://svc-a:8080' },
    })

    // Wait for withdrawal to reach node-beta
    await waitFor(() => {
      return !nodeB.bus.state.internal.routes.some((r) => r.name === 'service-alpha')
    })

    expect(nodeB.bus.state.internal.routes.some((r) => r.name === 'service-alpha')).toBe(false)
    // node-beta's own route should still be there
    expect(nodeA.bus.state.internal.routes.some((r) => r.name === 'service-beta')).toBe(true)
  })

  it('sendKeepalive succeeds over WebSocket and updates lastReceived', async () => {
    // Get B's peer record for alpha on beta
    const peerOnB = nodeB.bus.state.internal.peers.find((p) => p.name === 'node-alpha')!
    const beforeKeepalive = peerOnB.lastReceived

    // Small delay to ensure Date.now() advances
    await new Promise((r) => setTimeout(r, 15))

    // Node-alpha sends keepalive to node-beta
    // Need the peer record from alpha's side WITH peerToken
    const peerBetaOnAlpha = nodeA.bus.state.internal.peers.find((p) => p.name === 'node-beta')!
    await nodeA.transport.sendKeepalive(peerBetaOnAlpha)

    // Wait for lastReceived to update on beta's side
    await waitFor(() => {
      const p = nodeB.bus.state.internal.peers.find((pp) => pp.name === 'node-alpha')
      return p !== undefined && p.lastReceived > beforeKeepalive
    })

    const peerAfter = nodeB.bus.state.internal.peers.find((p) => p.name === 'node-alpha')!
    expect(peerAfter.lastReceived).toBeGreaterThan(beforeKeepalive)
  })
}, 15_000)
