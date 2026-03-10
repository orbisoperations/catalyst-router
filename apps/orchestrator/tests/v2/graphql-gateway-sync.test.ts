/**
 * Tests for GraphQL gateway sync in the v2 bus.
 *
 * Verifies that when routes change, the bus pushes updated GraphQL service lists
 * to the gateway via the injected GatewayClient. Mirrors the v1 handleGraphqlConfiguration
 * behavior with the v2 plan/commit architecture.
 */
import { describe, it, expect } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import type { GatewayClient } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: OrchestratorConfig = {
  node: { name: 'node-a', endpoint: 'ws://node-a:4000', domains: ['gql.local'] },
  gqlGatewayConfig: { endpoint: 'http://gateway:3000/rpc' },
}

const peerB: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['gql.local'],
}

const graphqlRoute = {
  name: 'users-gql',
  protocol: 'http:graphql' as const,
  endpoint: 'http://users-svc:8080/graphql',
}

const gqlRoute = {
  name: 'posts-gql',
  protocol: 'http:gql' as const,
  endpoint: 'http://posts-svc:8080/graphql',
}

const httpRoute = {
  name: 'api-rest',
  protocol: 'http' as const,
  endpoint: 'http://api:8080',
}

function mockGatewayClient(): GatewayClient & {
  calls: Array<{ services: Array<{ name: string; url: string }> }>
} {
  const calls: Array<{ services: Array<{ name: string; url: string }> }> = []
  return {
    calls,
    async updateConfig(config) {
      calls.push(config)
      return { success: true }
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GraphQL gateway sync', () => {
  it('syncs GraphQL routes to gateway on LocalRouteCreate', async () => {
    const gateway = mockGatewayClient()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      gatewayClient: gateway,
    })

    await bus.dispatch({ action: Actions.LocalRouteCreate, data: graphqlRoute })

    expect(gateway.calls).toHaveLength(1)
    expect(gateway.calls[0].services).toEqual([
      { name: 'users-gql', url: 'http://users-svc:8080/graphql' },
    ])
  })

  it('includes both http:graphql and http:gql protocol routes', async () => {
    const gateway = mockGatewayClient()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      gatewayClient: gateway,
    })

    await bus.dispatch({ action: Actions.LocalRouteCreate, data: graphqlRoute })
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: gqlRoute })

    // Second dispatch should include both routes
    expect(gateway.calls).toHaveLength(2)
    const lastSync = gateway.calls[1]
    expect(lastSync.services).toHaveLength(2)
    expect(lastSync.services.map((s) => s.name).sort()).toEqual(['posts-gql', 'users-gql'])
  })

  it('does NOT sync when only non-GraphQL routes exist', async () => {
    const gateway = mockGatewayClient()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      gatewayClient: gateway,
    })

    await bus.dispatch({ action: Actions.LocalRouteCreate, data: httpRoute })

    expect(gateway.calls).toHaveLength(0)
  })

  it('does NOT sync when no gateway client is configured', async () => {
    // No gatewayClient passed → sync is a no-op
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
    })

    // Should not throw
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: graphqlRoute })
  })

  it('syncs when remote GraphQL routes arrive via InternalProtocolUpdate', async () => {
    const gateway = mockGatewayClient()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      gatewayClient: gateway,
    })

    // Connect peer B
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })
    gateway.calls.length = 0

    // Receive a GraphQL route from peer B
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add',
              route: graphqlRoute,
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    expect(gateway.calls).toHaveLength(1)
    expect(gateway.calls[0].services).toEqual([
      { name: 'users-gql', url: 'http://users-svc:8080/graphql' },
    ])
  })

  it('syncs on route deletion (removes route from gateway service list)', async () => {
    const gateway = mockGatewayClient()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      gatewayClient: gateway,
    })

    await bus.dispatch({ action: Actions.LocalRouteCreate, data: graphqlRoute })
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: gqlRoute })
    gateway.calls.length = 0

    // Delete one GraphQL route
    await bus.dispatch({ action: Actions.LocalRouteDelete, data: graphqlRoute })

    expect(gateway.calls).toHaveLength(1)
    expect(gateway.calls[0].services).toEqual([
      { name: 'posts-gql', url: 'http://posts-svc:8080/graphql' },
    ])
  })

  it('gateway client errors are swallowed (fire-and-forget)', async () => {
    const gateway: GatewayClient = {
      async updateConfig() {
        throw new Error('Gateway unreachable')
      },
    }
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      gatewayClient: gateway,
    })

    // Should not throw despite gateway error
    await expect(
      bus.dispatch({ action: Actions.LocalRouteCreate, data: graphqlRoute })
    ).resolves.toBeDefined()
  })

  it('includes both local and internal GraphQL routes in sync', async () => {
    const gateway = mockGatewayClient()
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      gatewayClient: gateway,
    })

    // Add local GraphQL route
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: graphqlRoute })

    // Connect peer and receive remote GraphQL route
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })
    gateway.calls.length = 0

    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add',
              route: gqlRoute,
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    // Should contain both local and internal GraphQL routes
    expect(gateway.calls).toHaveLength(1)
    const services = gateway.calls[0].services
    expect(services).toHaveLength(2)
    expect(services.map((s) => s.name).sort()).toEqual(['posts-gql', 'users-gql'])
  })
})
