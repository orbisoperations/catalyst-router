import { describe, it, expect, beforeEach } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Test fixtures
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

async function setupConnectedPeer(bus: OrchestratorBus, peerInfo: PeerInfo) {
  await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
  await bus.dispatch({
    action: Actions.InternalProtocolConnected,
    data: { peerInfo },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('adapter health propagation', () => {
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(() => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config: configA, transport })
  })

  it('local route with health fields appears in state snapshot', async () => {
    const now = new Date().toISOString()

    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: {
        name: 'svc-alpha',
        protocol: 'http' as const,
        endpoint: 'http://svc-alpha:8080',
        healthStatus: 'up',
        responseTimeMs: 42,
        lastChecked: now,
      },
    })

    const snapshot = bus.getStateSnapshot()
    const route = snapshot.local.routes.find((r) => r.name === 'svc-alpha')

    expect(route).toBeDefined()
    expect(route?.healthStatus).toBe('up')
    expect(route?.responseTimeMs).toBe(42)
    expect(route?.lastChecked).toBe(now)
  })

  it('health fields propagate to peer via iBGP update', async () => {
    await setupConnectedPeer(bus, peerBInfo)
    transport.reset()

    const now = new Date().toISOString()

    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: {
        name: 'svc-beta',
        protocol: 'http' as const,
        endpoint: 'http://svc-beta:8080',
        healthStatus: 'down',
        responseTimeMs: null,
        lastChecked: now,
      },
    })

    const updateCalls = transport.getCallsFor('sendUpdate')
    expect(updateCalls).toHaveLength(1)

    const call = updateCalls[0]
    if (call.method !== 'sendUpdate') throw new Error('wrong call type')

    expect(call.message.updates).toHaveLength(1)
    const update = call.message.updates[0]
    expect(update.route.name).toBe('svc-beta')
    expect(update.route.healthStatus).toBe('down')
    expect(update.route.responseTimeMs).toBeNull()
    expect(update.route.lastChecked).toBe(now)
  })

  it('route without health fields defaults to undefined (backward compat)', async () => {
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: {
        name: 'svc-legacy',
        protocol: 'http' as const,
        endpoint: 'http://svc-legacy:8080',
      },
    })

    const snapshot = bus.getStateSnapshot()
    const route = snapshot.local.routes.find((r) => r.name === 'svc-legacy')

    expect(route).toBeDefined()
    expect(route?.healthStatus).toBeUndefined()
    expect(route?.responseTimeMs).toBeUndefined()
    expect(route?.lastChecked).toBeUndefined()
  })
})
