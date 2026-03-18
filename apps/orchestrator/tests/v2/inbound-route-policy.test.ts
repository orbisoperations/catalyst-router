/**
 * Tests for inbound route policy filtering (GAP-005).
 *
 * Verifies that the bus applies routePolicy.canReceive() on inbound
 * InternalProtocolUpdate actions before accepting routes into the RIB.
 */
import { describe, it, expect } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions, ConfigurableRoutePolicy } from '@catalyst/routing/v2'
import type { RoutePolicy } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: OrchestratorConfig = {
  node: { name: 'node-a', endpoint: 'ws://node-a:4000', domains: ['test.local'] },
}

const peerB: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['test.local'],
  peerToken: 'token-b',
}

function makeUpdate(routes: Array<{ name: string; protocol: string; endpoint: string }>) {
  return {
    updates: routes.map((r) => ({
      action: 'add' as const,
      route: r,
      nodePath: ['node-b'],
      originNode: 'node-b',
    })),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Inbound route policy', () => {
  it('default ConfigurableRoutePolicy accepts all inbound routes', async () => {
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      routePolicy: new ConfigurableRoutePolicy(),
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
        update: makeUpdate([
          { name: 'svc-alpha', protocol: 'http', endpoint: 'http://alpha:8080' },
          { name: 'svc-beta', protocol: 'http', endpoint: 'http://beta:8080' },
        ]),
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.state.internal.routes).toHaveLength(2)
  })

  it('rejects all routes when canReceive returns empty', async () => {
    const denyAll: RoutePolicy = {
      canSend: (_peer, routes) => routes,
      canReceive: () => [],
    }

    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      routePolicy: denyAll,
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
        update: makeUpdate([
          { name: 'svc-alpha', protocol: 'http', endpoint: 'http://alpha:8080' },
        ]),
      },
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toBe('All routes rejected by inbound policy')
  })

  it('partially filters routes — only accepted routes enter the RIB', async () => {
    const allowAlphaOnly: RoutePolicy = {
      canSend: (_peer, routes) => routes,
      canReceive: (_peer, routes) => routes.filter((r) => r.name === 'svc-alpha'),
    }

    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      routePolicy: allowAlphaOnly,
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
        update: makeUpdate([
          { name: 'svc-alpha', protocol: 'http', endpoint: 'http://alpha:8080' },
          { name: 'svc-beta', protocol: 'http', endpoint: 'http://beta:8080' },
        ]),
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.state.internal.routes).toHaveLength(1)
    expect(result.state.internal.routes[0].name).toBe('svc-alpha')
  })

  it('does not filter non-update actions', async () => {
    const denyAll: RoutePolicy = {
      canSend: (_peer, routes) => routes,
      canReceive: () => [],
    }

    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      routePolicy: denyAll,
    })

    // LocalPeerCreate should NOT be affected by canReceive
    const result = await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    expect(result.success).toBe(true)
  })

  it('passes without policy configured (no filtering)', async () => {
    const bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
      // No routePolicy
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
        update: makeUpdate([
          { name: 'svc-alpha', protocol: 'http', endpoint: 'http://alpha:8080' },
        ]),
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.state.internal.routes).toHaveLength(1)
  })
})
