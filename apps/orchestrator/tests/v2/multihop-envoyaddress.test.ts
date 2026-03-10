/**
 * Tests for multi-hop envoyAddress forwarding and port rewriting (GAP-007 + GAP-008).
 *
 * When a transit node (B) re-advertises routes learned from peer A to peer C,
 * it must rewrite envoyAddress to B's own envoy address and envoyPort to B's
 * locally-allocated egress port. This ensures C routes traffic through B's
 * envoy proxy rather than trying to reach A directly (which may be unreachable).
 */
import { describe, it, expect } from 'vitest'
import { OrchestratorBus, BusTransforms } from '../../src/v2/bus.js'
import type { BusPortAllocator } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo, DataChannelDefinition } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const configA: OrchestratorConfig = {
  node: {
    name: 'node-a',
    endpoint: 'ws://node-a:4000',
    domains: ['test.local'],
    envoyAddress: 'envoy-a.test.local:8443',
  },
  envoyConfig: {
    endpoint: 'http://envoy:3000/rpc',
    portRange: [[10000, 10100]],
  },
}

const peerB: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['test.local'],
  peerToken: 'token-b',
  envoyAddress: 'envoy-b.test.local:8443',
}

const peerC: PeerInfo = {
  name: 'node-c',
  endpoint: 'ws://node-c:4000',
  domains: ['test.local'],
  peerToken: 'token-c',
  envoyAddress: 'envoy-c.test.local:8443',
}

const httpRoute: DataChannelDefinition = {
  name: 'svc-alpha',
  protocol: 'http',
  endpoint: 'http://alpha:8080',
  envoyPort: 9000,
  envoyAddress: 'envoy-b.test.local:8443',
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockPortAllocator(): BusPortAllocator {
  const allocations = new Map<string, number>()
  let nextPort = 10000

  return {
    allocate(channelName: string) {
      const existing = allocations.get(channelName)
      if (existing !== undefined) {
        return { success: true, port: existing }
      }
      const port = nextPort++
      allocations.set(channelName, port)
      return { success: true, port }
    },
    release(channelName: string) {
      allocations.delete(channelName)
    },
    getPort(channelName: string) {
      return allocations.get(channelName)
    },
    getAllocations() {
      return allocations
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Multi-hop envoyAddress forwarding', () => {
  it('stamps envoyAddress on local route advertisements', async () => {
    const transport = new MockPeerTransport()
    const bus = new OrchestratorBus({
      config: configA,
      transport,
      portAllocator: mockPortAllocator(),
    })

    // Create a local route
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-local', protocol: 'http', endpoint: 'http://local:8080' },
    })

    // Connect peer C
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerC },
    })

    // The initial sync should include envoyAddress from node-a's config
    const sendCalls = transport.calls.filter(
      (c) => c.method === 'sendUpdate' && c.peer.name === 'node-c'
    )
    expect(sendCalls).toHaveLength(1)

    const updates = sendCalls[0].message!.updates
    expect(updates).toHaveLength(1)
    expect(updates[0].route.envoyAddress).toBe('envoy-a.test.local:8443')
  })

  it('rewrites envoyAddress and envoyPort when re-advertising internal routes', async () => {
    const transport = new MockPeerTransport()
    const ports = mockPortAllocator()
    const bus = new OrchestratorBus({
      config: configA,
      transport,
      portAllocator: ports,
    })

    // Connect peer B and peer C
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerC },
    })
    transport.calls.length = 0

    // Receive a route from peer B (with B's envoyAddress/envoyPort)
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add',
              route: httpRoute,
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    // The route should be forwarded to peer C with A's envoyAddress and A's egress port
    const sendCalls = transport.calls.filter(
      (c) => c.method === 'sendUpdate' && c.peer.name === 'node-c'
    )
    expect(sendCalls).toHaveLength(1)

    const updates = sendCalls[0].message!.updates
    expect(updates).toHaveLength(1)

    // envoyAddress should be rewritten to node-a's address (transit node)
    expect(updates[0].route.envoyAddress).toBe('envoy-a.test.local:8443')

    // envoyPort should be rewritten to A's egress port (NOT B's original 9000)
    const egressPort = ports.getPort('egress_svc-alpha_via_node-b')
    expect(egressPort).toBeDefined()
    expect(updates[0].route.envoyPort).toBe(egressPort)
  })

  it('does NOT rewrite envoyAddress when not configured on the node', async () => {
    const configNoEnvoy: OrchestratorConfig = {
      node: { name: 'node-a', endpoint: 'ws://node-a:4000', domains: ['test.local'] },
    }
    const transport = new MockPeerTransport()
    const bus = new OrchestratorBus({
      config: configNoEnvoy,
      transport,
    })

    // Create a local route and connect peer
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-local', protocol: 'http', endpoint: 'http://local:8080' },
    })
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerC },
    })

    const sendCalls = transport.calls.filter(
      (c) => c.method === 'sendUpdate' && c.peer.name === 'node-c'
    )
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0].message!.updates[0].route.envoyAddress).toBeUndefined()
  })

  it('preserves envoyAddress through BusTransforms.toDataChannel', () => {
    const route: DataChannelDefinition = {
      name: 'svc-test',
      protocol: 'http',
      endpoint: 'http://test:8080',
      envoyPort: 9000,
      envoyAddress: 'envoy-origin.test.local:8443',
    }

    // Without overrides — passes through
    const result = BusTransforms.toDataChannel(route)
    expect(result.envoyAddress).toBe('envoy-origin.test.local:8443')
    expect(result.envoyPort).toBe(9000)

    // With overrides — rewrites
    const rewritten = BusTransforms.toDataChannel(route, {
      envoyAddress: 'envoy-transit.test.local:8443',
      envoyPort: 10050,
    })
    expect(rewritten.envoyAddress).toBe('envoy-transit.test.local:8443')
    expect(rewritten.envoyPort).toBe(10050)
  })

  it('uses egress port in delta propagation (buildUpdatesForPeer)', async () => {
    const transport = new MockPeerTransport()
    const ports = mockPortAllocator()
    const bus = new OrchestratorBus({
      config: configA,
      transport,
      portAllocator: ports,
    })

    // Connect both peers
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerC },
    })

    // Add a local route — delta should propagate to both peers with A's envoyAddress
    transport.calls.length = 0
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-delta', protocol: 'http', endpoint: 'http://delta:8080' },
    })

    const toB = transport.calls.find((c) => c.method === 'sendUpdate' && c.peer.name === 'node-b')
    const toC = transport.calls.find((c) => c.method === 'sendUpdate' && c.peer.name === 'node-c')

    expect(toB).toBeDefined()
    expect(toC).toBeDefined()
    expect(toB!.message!.updates[0].route.envoyAddress).toBe('envoy-a.test.local:8443')
    expect(toC!.message!.updates[0].route.envoyAddress).toBe('envoy-a.test.local:8443')
  })

  it('removal updates still include envoyAddress rewriting', async () => {
    const transport = new MockPeerTransport()
    const ports = mockPortAllocator()
    const bus = new OrchestratorBus({
      config: configA,
      transport,
      portAllocator: ports,
    })

    // Connect peer C and create a local route
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerC },
    })
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-remove', protocol: 'http', endpoint: 'http://remove:8080' },
    })
    transport.calls.length = 0

    // Remove the local route
    await bus.dispatch({
      action: Actions.LocalRouteDelete,
      data: { name: 'svc-remove', protocol: 'http', endpoint: 'http://remove:8080' },
    })

    const sendCalls = transport.calls.filter(
      (c) => c.method === 'sendUpdate' && c.peer.name === 'node-c'
    )
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0].message!.updates[0].action).toBe('remove')
    // Even removals carry envoyAddress for identification
    expect(sendCalls[0].message!.updates[0].route.envoyAddress).toBe('envoy-a.test.local:8443')
  })
})
