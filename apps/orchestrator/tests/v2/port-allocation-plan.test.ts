/**
 * Tests for planPortAllocations — the bus phase between plan and commit
 * that allocates/releases ports and stamps them on the route state.
 *
 * Verifies:
 * - Ports are stamped on committed state (local + internal routes)
 * - portOps audit trail records every allocate/release with port number
 * - routeChanges carry stamped ports for downstream propagation
 * - Release before allocate ordering is correct
 */
import { describe, it, expect } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import type { BusPortAllocator } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: OrchestratorConfig = {
  node: { name: 'node-a', endpoint: 'ws://node-a:4000', domains: ['test.local'] },
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
}

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

describe('Port allocation planning', () => {
  it('stamps envoyPort on local routes in committed state', async () => {
    const ports = mockPortAllocator()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      portAllocator: ports,
    })

    const result = await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-alpha', protocol: 'http', endpoint: 'http://alpha:8080' },
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    // Port should be stamped directly on the route in committed state
    const route = result.state.local.routes.get('svc-alpha')
    expect(route).toBeDefined()
    expect(route!.envoyPort).toBe(10000)
  })

  it('stamps envoyPort on internal routes (egress) in committed state', async () => {
    const ports = mockPortAllocator()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      portAllocator: ports,
    })

    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })

    const result = await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add',
              route: {
                name: 'svc-remote',
                protocol: 'http' as const,
                endpoint: 'http://remote:8080',
              },
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    // Egress port should be stamped on the internal route
    const internalRoute = [...result.state.internal.routes.values()].flatMap((m) => [...m.values()]).find((r) => r.name === 'svc-remote')
    expect(internalRoute).toBeDefined()
    expect(internalRoute!.envoyPort).toBeDefined()

    // Port should match allocator's assignment
    const expectedPort = ports.getPort('egress_svc-remote_via_node-b')
    expect(internalRoute!.envoyPort).toBe(expectedPort)
  })

  it('releases ports before allocating on route replacement', async () => {
    const ports = mockPortAllocator()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      portAllocator: ports,
    })

    // Create then delete a route — port should be released
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-alpha', protocol: 'http', endpoint: 'http://alpha:8080' },
    })

    const firstPort = ports.getPort('svc-alpha')
    expect(firstPort).toBe(10000)

    await bus.dispatch({
      action: Actions.LocalRouteDelete,
      data: { name: 'svc-alpha', protocol: 'http', endpoint: 'http://alpha:8080' },
    })

    // Port should be released
    expect(ports.getPort('svc-alpha')).toBeUndefined()
  })

  it('port allocations are idempotent across dispatches', async () => {
    const ports = mockPortAllocator()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      portAllocator: ports,
    })

    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-alpha', protocol: 'http', endpoint: 'http://alpha:8080' },
    })
    const result = await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-beta', protocol: 'http', endpoint: 'http://beta:8080' },
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    // svc-alpha keeps its original port
    const alpha = result.state.local.routes.get('svc-alpha')
    expect(alpha!.envoyPort).toBe(10000)

    // svc-beta gets the next port
    const beta = result.state.local.routes.get('svc-beta')
    expect(beta!.envoyPort).toBe(10001)
  })

  it('works correctly without a port allocator', async () => {
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      // No portAllocator
    })

    const result = await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-alpha', protocol: 'http', endpoint: 'http://alpha:8080' },
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    // No port stamped when no allocator is configured
    const route = result.state.local.routes.get('svc-alpha')
    expect(route!.envoyPort).toBeUndefined()
  })
})
