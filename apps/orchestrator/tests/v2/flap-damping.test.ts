import { describe, it, expect } from 'vitest'
import {
  RoutingInformationBase,
  Actions,
  newRouteTable,
  routeKey,
  FLAP_PENALTY_INCREMENT,
  FLAP_SUPPRESS_THRESHOLD,
  FLAP_HALF_LIFE_MS,
  FLAP_MAX_SUPPRESS_MS,
} from '@catalyst/routing/v2'
import type { RouteTable, PeerRecord, PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nodeId = 'node-a'
const peerB: PeerInfo = { name: 'node-b', endpoint: 'ws://b:4000', domains: ['test.local'] }
const route1 = { name: 'svc-1', protocol: 'http' as const, endpoint: 'http://svc-1:8080' }
const route2 = { name: 'svc-2', protocol: 'http' as const, endpoint: 'http://svc-2:8080' }

function connectedState(): RouteTable {
  const state = newRouteTable()
  const peer: PeerRecord = {
    ...peerB,
    connectionStatus: 'connected',
    lastConnected: 1000,
    holdTime: 90_000,
    lastSent: 0,
    lastReceived: 1000,
  }
  state.internal.peers = [peer]
  return state
}

function addAction(route: typeof route1) {
  return {
    action: Actions.InternalProtocolUpdate as const,
    data: {
      peerInfo: peerB,
      update: {
        updates: [{ action: 'add' as const, route, nodePath: ['node-b'], originNode: 'node-b' }],
      },
    },
  }
}

function removeAction(route: typeof route1) {
  return {
    action: Actions.InternalProtocolUpdate as const,
    data: {
      peerInfo: peerB,
      update: {
        updates: [{ action: 'remove' as const, route, nodePath: ['node-b'], originNode: 'node-b' }],
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('route flap damping (RFC 7196 / RIPE-580)', () => {
  it('single withdraw/re-add below threshold — not suppressed', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = connectedState()

    // Add route
    const a1 = addAction(route1)
    const p1 = rib.plan(a1, state)
    rib.commit(p1, a1)

    // Remove route
    const r1 = removeAction(route1)
    const p2 = rib.plan(r1, rib.state)
    rib.commit(p2, r1)

    // Re-add route
    const a2 = addAction(route1)
    const p3 = rib.plan(a2, rib.state)
    rib.commit(p3, a2)

    const fk = routeKey(route1) + ':node-b'
    const entry = rib.flapState.get(fk)
    expect(entry).toBeDefined()
    // One remove (1000) + one add-after-remove (decayed ~1000 + 1000 ≈ 2000)
    expect(entry!.penalty).toBeGreaterThanOrEqual(FLAP_PENALTY_INCREMENT)
    expect(entry!.penalty).toBeLessThan(FLAP_SUPPRESS_THRESHOLD)
    expect(entry!.suppressed).toBe(false)
  })

  it('six rapid flaps exceed threshold — suppressed', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = connectedState()

    let currentState = state
    for (let i = 0; i < 6; i++) {
      const add = addAction(route1)
      const ap = rib.plan(add, currentState)
      rib.commit(ap, add)
      currentState = rib.state

      const rm = removeAction(route1)
      const rp = rib.plan(rm, currentState)
      rib.commit(rp, rm)
      currentState = rib.state
    }

    // Final add
    const finalAdd = addAction(route1)
    const fp = rib.plan(finalAdd, currentState)
    rib.commit(fp, finalAdd)

    const fk = routeKey(route1) + ':node-b'
    const entry = rib.flapState.get(fk)
    expect(entry).toBeDefined()
    expect(entry!.suppressed).toBe(true)
    expect(entry!.penalty).toBeGreaterThanOrEqual(FLAP_SUPPRESS_THRESHOLD)
  })

  it('different routes from same peer damped independently', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = connectedState()

    // Flap route1 six times to suppress it
    let currentState = state
    for (let i = 0; i < 6; i++) {
      const add = addAction(route1)
      const ap = rib.plan(add, currentState)
      rib.commit(ap, add)
      currentState = rib.state

      const rm = removeAction(route1)
      const rp = rib.plan(rm, currentState)
      rib.commit(rp, rm)
      currentState = rib.state
    }
    // Final add for route1
    const finalAdd1 = addAction(route1)
    const fp1 = rib.plan(finalAdd1, currentState)
    rib.commit(fp1, finalAdd1)
    currentState = rib.state

    // Add route2 normally (no flapping)
    const add2 = addAction(route2)
    const ap2 = rib.plan(add2, currentState)
    rib.commit(ap2, add2)

    const fk1 = routeKey(route1) + ':node-b'
    const fk2 = routeKey(route2) + ':node-b'

    const entry1 = rib.flapState.get(fk1)
    expect(entry1).toBeDefined()
    expect(entry1!.suppressed).toBe(true)

    // route2 should have no flap entry (never withdrawn)
    const entry2 = rib.flapState.get(fk2)
    expect(entry2).toBeUndefined()
  })

  it('tick decays penalty — suppressed route becomes reusable after 4 half-lives', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = connectedState()

    // Flap route1 six times to suppress it
    let currentState = state
    for (let i = 0; i < 6; i++) {
      const add = addAction(route1)
      const ap = rib.plan(add, currentState)
      rib.commit(ap, add)
      currentState = rib.state

      const rm = removeAction(route1)
      const rp = rib.plan(rm, currentState)
      rib.commit(rp, rm)
      currentState = rib.state
    }

    // Final add
    const finalAdd = addAction(route1)
    const fp = rib.plan(finalAdd, currentState)
    rib.commit(fp, finalAdd)
    currentState = rib.state

    const fk = routeKey(route1) + ':node-b'
    expect(rib.flapState.get(fk)?.suppressed).toBe(true)

    // Dispatch Tick far enough in the future: penalty is ~12000 after 6 flap cycles.
    // 5 half-lives => 12000 * 0.5^5 = 375 < 750 reuse threshold.
    const tickAction = {
      action: Actions.Tick as const,
      data: { now: Date.now() + FLAP_HALF_LIFE_MS * 5 },
    }
    const tickPlan = rib.plan(tickAction, currentState)
    rib.commit(tickPlan, tickAction)

    const entry = rib.flapState.get(fk)
    expect(entry).toBeDefined()
    expect(entry!.suppressed).toBe(false)
  })

  it('max suppress time cap — unsuppressed after 30 minutes despite high penalty', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = connectedState()

    // Flap route1 twenty times to get very high penalty
    let currentState = state
    for (let i = 0; i < 20; i++) {
      const add = addAction(route1)
      const ap = rib.plan(add, currentState)
      rib.commit(ap, add)
      currentState = rib.state

      const rm = removeAction(route1)
      const rp = rib.plan(rm, currentState)
      rib.commit(rp, rm)
      currentState = rib.state
    }

    // Final add
    const finalAdd = addAction(route1)
    const fp = rib.plan(finalAdd, currentState)
    rib.commit(fp, finalAdd)
    currentState = rib.state

    const fk = routeKey(route1) + ':node-b'
    expect(rib.flapState.get(fk)?.suppressed).toBe(true)

    // Dispatch Tick just past the max suppress duration (30 min + 1 sec)
    const tickAction = {
      action: Actions.Tick as const,
      data: { now: Date.now() + FLAP_MAX_SUPPRESS_MS + 1000 },
    }
    const tickPlan = rib.plan(tickAction, currentState)
    rib.commit(tickPlan, tickAction)

    const entry = rib.flapState.get(fk)
    // Should be unsuppressed even though penalty may still be above reuse threshold
    expect(entry).toBeDefined()
    expect(entry!.suppressed).toBe(false)
  })
})
