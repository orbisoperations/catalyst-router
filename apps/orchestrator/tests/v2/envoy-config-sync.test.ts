/**
 * Tests for Envoy config sync in the v2 bus.
 *
 * Verifies that when routes change, the bus allocates/releases ports via the
 * injected PortAllocator and pushes the full route config to the envoy service
 * via the injected EnvoyClient. Mirrors v1 handleEnvoyConfiguration behavior.
 */
import { describe, it, expect } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import type { EnvoyClient, BusPortAllocator } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions, CloseCodes } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo, InternalRoute, DataChannelDefinition } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: OrchestratorConfig = {
  node: { name: 'node-a', endpoint: 'ws://node-a:4000', domains: ['envoy.local'] },
  envoyConfig: {
    endpoint: 'http://envoy:3000/rpc',
    portRange: [[10000, 10100]],
  },
}

const peerB: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['envoy.local'],
}

const httpRoute = {
  name: 'svc-alpha',
  protocol: 'http' as const,
  endpoint: 'http://alpha:8080',
}

const httpRoute2 = {
  name: 'svc-beta',
  protocol: 'http' as const,
  endpoint: 'http://beta:8080',
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface EnvoyCall {
  local: DataChannelDefinition[]
  internal: InternalRoute[]
  portAllocations?: Record<string, number>
}

function mockEnvoyClient(): EnvoyClient & { calls: EnvoyCall[] } {
  const calls: EnvoyCall[] = []
  return {
    calls,
    async updateRoutes(cfg) {
      calls.push(cfg as EnvoyCall)
      return { success: true }
    },
  }
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
    getAllocations() {
      return allocations
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Envoy config sync', () => {
  it('allocates port for local route and pushes to envoy on LocalRouteCreate', async () => {
    const envoy = mockEnvoyClient()
    const ports = mockPortAllocator()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      envoyClient: envoy,
      portAllocator: ports,
    })

    await bus.dispatch({ action: Actions.LocalRouteCreate, data: httpRoute })

    expect(envoy.calls).toHaveLength(1)
    expect(envoy.calls[0].local).toHaveLength(1)
    expect(envoy.calls[0].local[0].name).toBe('svc-alpha')

    // Port should be allocated
    const allocs = envoy.calls[0].portAllocations!
    expect(allocs['svc-alpha']).toBe(10000)
  })

  it('releases port on LocalRouteDelete', async () => {
    const envoy = mockEnvoyClient()
    const ports = mockPortAllocator()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      envoyClient: envoy,
      portAllocator: ports,
    })

    await bus.dispatch({ action: Actions.LocalRouteCreate, data: httpRoute })
    envoy.calls.length = 0

    await bus.dispatch({ action: Actions.LocalRouteDelete, data: httpRoute })

    expect(envoy.calls).toHaveLength(1)
    expect(envoy.calls[0].local).toHaveLength(0)
    // Port should have been released — not in allocations
    const allocs = envoy.calls[0].portAllocations!
    expect(allocs['svc-alpha']).toBeUndefined()
  })

  it('allocates egress ports for internal routes from peer', async () => {
    const envoy = mockEnvoyClient()
    const ports = mockPortAllocator()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      envoyClient: envoy,
      portAllocator: ports,
    })

    // Connect peer B
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })
    envoy.calls.length = 0

    // Receive route from peer B
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

    expect(envoy.calls).toHaveLength(1)
    expect(envoy.calls[0].internal).toHaveLength(1)
    expect(envoy.calls[0].internal[0].name).toBe('svc-alpha')

    // Egress port should be allocated
    const allocs = envoy.calls[0].portAllocations!
    expect(allocs['egress_svc-alpha_via_node-b']).toBeDefined()
  })

  it('releases egress ports on peer close', async () => {
    const envoy = mockEnvoyClient()
    const ports = mockPortAllocator()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      envoyClient: envoy,
      portAllocator: ports,
    })

    // Connect peer B and receive route
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })
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
    envoy.calls.length = 0

    // Close peer B (normal close — removes routes)
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: peerB, code: CloseCodes.NORMAL },
    })

    expect(envoy.calls).toHaveLength(1)
    expect(envoy.calls[0].internal).toHaveLength(0)
  })

  it('does NOT sync when no envoy client is configured', async () => {
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
    })

    // Should not throw
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: httpRoute })
  })

  it('envoy client errors are swallowed (fire-and-forget)', async () => {
    const envoy: EnvoyClient = {
      async updateRoutes() {
        throw new Error('Envoy unreachable')
      },
    }
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      envoyClient: envoy,
      portAllocator: mockPortAllocator(),
    })

    await expect(
      bus.dispatch({ action: Actions.LocalRouteCreate, data: httpRoute })
    ).resolves.toBeDefined()
  })

  it('port allocations are idempotent across multiple dispatches', async () => {
    const envoy = mockEnvoyClient()
    const ports = mockPortAllocator()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      envoyClient: envoy,
      portAllocator: ports,
    })

    await bus.dispatch({ action: Actions.LocalRouteCreate, data: httpRoute })
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: httpRoute2 })

    // svc-alpha should still have port 10000, svc-beta gets 10001
    const lastCall = envoy.calls[envoy.calls.length - 1]
    expect(lastCall.portAllocations!['svc-alpha']).toBe(10000)
    expect(lastCall.portAllocations!['svc-beta']).toBe(10001)
  })

  it('includes both local and internal routes with port allocations', async () => {
    const envoy = mockEnvoyClient()
    const ports = mockPortAllocator()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      envoyClient: envoy,
      portAllocator: ports,
    })

    // Add local route
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: httpRoute })

    // Connect peer and receive route
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })
    envoy.calls.length = 0

    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add',
              route: httpRoute2,
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    const lastCall = envoy.calls[envoy.calls.length - 1]
    expect(lastCall.local).toHaveLength(1)
    expect(lastCall.internal).toHaveLength(1)

    // Both should have port allocations
    const allocs = lastCall.portAllocations!
    expect(allocs['svc-alpha']).toBeDefined() // local port
    expect(allocs['egress_svc-beta_via_node-b']).toBeDefined() // egress port
  })
})
