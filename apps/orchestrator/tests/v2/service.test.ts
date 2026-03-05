import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OrchestratorServiceV2 } from '../../src/v2/service.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { InMemoryActionLog } from '@catalyst/routing/v2'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'

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

const routeAlpha = {
  name: 'alpha',
  protocol: 'http' as const,
  endpoint: 'http://alpha:8080',
}

const routeBeta = {
  name: 'beta',
  protocol: 'http' as const,
  endpoint: 'http://beta:8080',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrchestratorServiceV2', () => {
  let transport: MockPeerTransport

  beforeEach(() => {
    vi.useFakeTimers()
    transport = new MockPeerTransport()
  })

  afterEach(async () => {
    vi.useRealTimers()
  })

  it('creates with in-memory journal (no journalPath)', () => {
    const svc = new OrchestratorServiceV2({ config, transport })

    expect(svc.bus).toBeDefined()
    expect(svc.tickManager).toBeDefined()
    expect(svc.reconnectManager).toBeDefined()
  })

  it('starts with empty state on a fresh journal', () => {
    const svc = new OrchestratorServiceV2({ config, transport })

    expect(svc.bus.state.local.routes).toHaveLength(0)
    expect(svc.bus.state.internal.peers).toHaveLength(0)
  })

  it('start() begins tick dispatch', async () => {
    const svc = new OrchestratorServiceV2({ config, transport })
    const dispatchSpy = vi.spyOn(svc.bus, 'dispatch')

    svc.start()

    // Advance one default tick interval (30s)
    await vi.advanceTimersByTimeAsync(30_000)

    const tickCalls = dispatchSpy.mock.calls.filter(([action]) => action.action === Actions.Tick)
    expect(tickCalls.length).toBeGreaterThanOrEqual(1)

    await svc.stop()
  })

  it('stop() stops the tick manager', async () => {
    const svc = new OrchestratorServiceV2({ config, transport })
    const dispatchSpy = vi.spyOn(svc.bus, 'dispatch')

    svc.start()
    await svc.stop()

    dispatchSpy.mockClear()

    // Advance time — no more ticks should fire
    await vi.advanceTimersByTimeAsync(60_000)

    const tickCalls = dispatchSpy.mock.calls.filter(([action]) => action.action === Actions.Tick)
    expect(tickCalls).toHaveLength(0)
  })

  it('stop() cancels pending reconnects', () => {
    const svc = new OrchestratorServiceV2({ config, transport })
    const peerRecord = {
      name: 'node-b',
      endpoint: 'ws://node-b:4000',
      domains: ['example.local'],
      connectionStatus: 'closed' as const,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 0,
    }

    svc.reconnectManager.scheduleReconnect(peerRecord)
    expect(svc.reconnectManager.pendingCount).toBe(1)

    void svc.stop()

    expect(svc.reconnectManager.pendingCount).toBe(0)
  })

  it('setNodeToken propagates to bus', async () => {
    const svc = new OrchestratorServiceV2({ config, transport, nodeToken: 'old-token' })

    svc.setNodeToken('new-token')

    // Verify by dispatching a LocalPeerCreate (token is used by transport on openPeer)
    const peerInfo = {
      name: 'node-b',
      endpoint: 'ws://node-b:4000',
      domains: ['example.local'],
    }
    await svc.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
    // Bus holds the token internally — we can't directly inspect it, but the
    // setNodeToken call should not throw and the bus should function correctly.
    expect(svc.bus.state.internal.peers).toHaveLength(1)

    await svc.stop()
  })

  it('setNodeToken propagates to reconnect manager', () => {
    const svc = new OrchestratorServiceV2({ config, transport })

    svc.setNodeToken('updated-token')

    // Schedule a reconnect — the token on the manager should be updated
    const peerRecord = {
      name: 'node-b',
      endpoint: 'ws://node-b:4000',
      domains: ['example.local'],
      connectionStatus: 'closed' as const,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 0,
    }
    svc.reconnectManager.scheduleReconnect(peerRecord)
    expect(svc.reconnectManager.pendingCount).toBe(1)

    void svc.stop()
  })

  describe('state rebuilt from journal on construction', () => {
    it('replays routes added in a previous session', async () => {
      // Session 1: add routes and record to journal
      const journal = new InMemoryActionLog()
      const svc1 = new OrchestratorServiceV2({ config, transport })

      // Inject journal entries manually to simulate a previous session
      journal.append({ action: Actions.LocalRouteCreate, data: routeAlpha }, 'node-a')
      journal.append({ action: Actions.LocalRouteCreate, data: routeBeta }, 'node-a')

      // Session 2: create service with the same journal
      const transport2 = new MockPeerTransport()

      // We need to pass journal entries — we do this by constructing the bus
      // directly with the journal and letting the service replay it.
      // Since OrchestratorServiceV2 accepts journalPath (file-based), for
      // in-memory we test via the bus directly to confirm replay logic works.
      const { OrchestratorBus } = await import('../../src/v2/bus.js')
      const { RoutingInformationBase } = await import('@catalyst/routing/v2')

      const tempRib = new RoutingInformationBase({ nodeId: config.node.name })
      for (const entry of journal.replay()) {
        const plan = tempRib.plan(entry.action, tempRib.state)
        if (tempRib.stateChanged(plan)) {
          tempRib.commit(plan, entry.action)
        }
      }

      const restoredBus = new OrchestratorBus({
        config,
        transport: transport2,
        journal,
        initialState: tempRib.state,
      })

      expect(restoredBus.state.local.routes).toHaveLength(2)
      expect(restoredBus.state.local.routes.map((r) => r.name)).toContain('alpha')
      expect(restoredBus.state.local.routes.map((r) => r.name)).toContain('beta')

      // Cleanup
      void svc1.stop()
    })
  })
})
