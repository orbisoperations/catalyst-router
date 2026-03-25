/**
 * Integration test: Route policy enforcement across propagation paths.
 *
 * Verifies route policy behavior in scenarios not covered by unit tests:
 * - Policy enforcement during syncRoutesToPeer (initial sync)
 * - Route removal bypass: removals always propagate regardless of policy
 */
import { describe, it, expect } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { RoutePolicy, PeerRecord, InternalRoute } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const configA: OrchestratorConfig = {
  node: { name: 'node-a', endpoint: 'ws://node-a:4000', domains: ['policy.local'] },
}

const peerB: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['policy.local'],
  peerToken: 'token-b',
}

const peerC: PeerInfo = {
  name: 'node-c',
  endpoint: 'ws://node-c:4000',
  domains: ['policy.local'],
  peerToken: 'token-c',
}

const routeAlpha = {
  name: 'alpha',
  protocol: 'http' as const,
  endpoint: 'http://alpha:8080',
}

// ---------------------------------------------------------------------------
// Policy implementations
// ---------------------------------------------------------------------------

/** Blocks all routes from being sent. Accepts all inbound. */
const denyAllPolicy: RoutePolicy = {
  canSend(_peer: PeerRecord, _routes: InternalRoute[]): InternalRoute[] {
    return []
  },
  canReceive(_peer, routes) {
    return routes
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function connectPeer(bus: OrchestratorBus, peer: PeerInfo): Promise<void> {
  await bus.dispatch({ action: Actions.LocalPeerCreate, data: peer })
  await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo: peer } })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Route policy: enforcement during initial sync (syncRoutesToPeer)', () => {
  it('deny-all policy blocks internal routes from being sent during initial sync', async () => {
    const transport = new MockPeerTransport()
    const bus = new OrchestratorBus({
      config: configA,
      transport,
      routePolicy: denyAllPolicy,
    })

    // Add peer C and receive a route from C
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerC },
    })
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerC,
        update: {
          updates: [
            {
              action: 'add',
              route: routeAlpha,
              nodePath: ['node-c'],
              originNode: 'node-c',
            },
          ],
        },
      },
    })
    transport.reset()

    // Now connect B — initial sync fires
    await connectPeer(bus, peerB)

    // Sync to B should NOT include C's route (policy denied)
    const updateCalls = transport
      .getCallsFor('sendUpdate')
      .filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-b')

    // Either no update call at all, or update has no routes
    if (updateCalls.length > 0) {
      const firstUpdate = updateCalls[0]
      if (firstUpdate.method === 'sendUpdate') {
        const internalRoutes = firstUpdate.message.updates.filter((u) => u.route.name === 'alpha')
        expect(internalRoutes).toHaveLength(0)
      }
    }
  })

  it('local routes are NOT subject to policy during initial sync', async () => {
    const transport = new MockPeerTransport()
    const bus = new OrchestratorBus({
      config: configA,
      transport,
      routePolicy: denyAllPolicy,
    })

    // Add a local route
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })

    // Connect B
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    transport.reset()
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })

    // Local routes should still be sent (policy only applies to internal routes)
    const updateCalls = transport
      .getCallsFor('sendUpdate')
      .filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-b')

    expect(updateCalls.length).toBeGreaterThanOrEqual(1)
    const firstUpdate = updateCalls[0]
    if (firstUpdate.method === 'sendUpdate') {
      expect(firstUpdate.message.updates.some((u) => u.route.name === 'alpha')).toBe(true)
    }
  })
})

describe('Route policy: removal bypass (bus.ts lines 239-241)', () => {
  it('route removal always propagates even with deny-all policy', async () => {
    // Start without policy to allow initial propagation
    const transport = new MockPeerTransport()
    const busNoPolicy = new OrchestratorBus({ config: configA, transport })

    // Add peers B and C, receive route from C
    await connectPeer(busNoPolicy, peerB)
    await connectPeer(busNoPolicy, peerC)
    await busNoPolicy.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerC,
        update: {
          updates: [
            {
              action: 'add',
              route: routeAlpha,
              nodePath: ['node-c'],
              originNode: 'node-c',
            },
          ],
        },
      },
    })
    // Verify alpha was propagated to B
    const addCalls = transport
      .getCallsFor('sendUpdate')
      .filter(
        (c) =>
          c.method === 'sendUpdate' &&
          c.peer.name === 'node-b' &&
          c.message.updates.some((u) => u.route.name === 'alpha' && u.action === 'add')
      )
    expect(addCalls.length).toBeGreaterThanOrEqual(1)
    transport.reset()

    // Now create a NEW bus with deny-all policy but same state (simulate policy being applied)
    const transportPolicy = new MockPeerTransport()
    const busWithPolicy = new OrchestratorBus({
      config: configA,
      transport: transportPolicy,
      routePolicy: denyAllPolicy,
      initialState: busNoPolicy.state,
    })

    // Remove route from C
    await busWithPolicy.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerC,
        update: {
          updates: [
            {
              action: 'remove',
              route: routeAlpha,
              nodePath: ['node-c'],
              originNode: 'node-c',
            },
          ],
        },
      },
    })

    // Removal should reach B despite deny-all policy
    const removeCalls = transportPolicy
      .getCallsFor('sendUpdate')
      .filter(
        (c) =>
          c.method === 'sendUpdate' &&
          c.peer.name === 'node-b' &&
          c.message.updates.some((u) => u.route.name === 'alpha' && u.action === 'remove')
      )
    expect(removeCalls.length).toBeGreaterThanOrEqual(1)
  })
})
