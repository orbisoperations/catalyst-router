import { describe, it, expect, vi } from 'vitest'
import { RoutingInformationBase } from '../../../src/v2/rib/rib.js'
import { InMemoryActionLog } from '../../../src/v2/journal/in-memory-action-log.js'
import { newRouteTable } from '../../../src/v2/state.js'
import { Actions } from '../../../src/v2/action-types.js'
import { CloseCodes } from '../../../src/v2/close-codes.js'
import type { Action } from '../../../src/v2/schema.js'
import type { PeerInfo, RouteTable } from '../../../src/v2/state.js'
import type { DataChannelDefinition } from '../../../src/v2/datachannel.js'

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

function makePeer(name: string, overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    name,
    domains: ['example.com'],
    ...overrides,
  }
}

function makeRoute(
  name: string,
  overrides: Partial<DataChannelDefinition> = {}
): DataChannelDefinition {
  return {
    name,
    protocol: 'http' as const,
    ...overrides,
  }
}

function makeLocalPeerCreate(peer: PeerInfo): Action {
  return { action: Actions.LocalPeerCreate, data: peer }
}

function makeLocalPeerUpdate(peer: PeerInfo): Action {
  return { action: Actions.LocalPeerUpdate, data: peer }
}

function makeLocalPeerDelete(name: string): Action {
  return { action: Actions.LocalPeerDelete, data: { name } }
}

function makeLocalRouteCreate(route: DataChannelDefinition): Action {
  return { action: Actions.LocalRouteCreate, data: route }
}

function makeLocalRouteDelete(route: DataChannelDefinition): Action {
  return { action: Actions.LocalRouteDelete, data: route }
}

function makeProtocolOpen(peer: PeerInfo, holdTime?: number): Action {
  return {
    action: Actions.InternalProtocolOpen,
    data: { peerInfo: peer, holdTime },
  }
}

function makeProtocolConnected(peer: PeerInfo): Action {
  return { action: Actions.InternalProtocolConnected, data: { peerInfo: peer } }
}

function makeProtocolClose(peer: PeerInfo, code: number, reason?: string): Action {
  return { action: Actions.InternalProtocolClose, data: { peerInfo: peer, code, reason } }
}

function makeProtocolUpdate(
  peer: PeerInfo,
  updates: Array<{
    action: 'add' | 'remove'
    route: DataChannelDefinition
    nodePath: string[]
    originNode: string
  }>
): Action {
  return {
    action: Actions.InternalProtocolUpdate,
    data: { peerInfo: peer, update: { updates } },
  }
}

function makeProtocolKeepalive(peer: PeerInfo): Action {
  return { action: Actions.InternalProtocolKeepalive, data: { peerInfo: peer } }
}

function makeTick(now: number): Action {
  return { action: Actions.Tick, data: { now } }
}

// Helper: run plan+commit in one shot
function apply(rib: RoutingInformationBase, action: Action) {
  const plan = rib.plan(action, rib.state)
  rib.commit(plan, action)
  return plan
}

// Helper: build a RIB with a pre-registered (and connected) peer
function ribWithConnectedPeer(
  nodeId: string,
  peerName: string
): { rib: RoutingInformationBase; peer: PeerInfo } {
  const rib = new RoutingInformationBase({ nodeId })
  const peer = makePeer(peerName)
  apply(rib, makeLocalPeerCreate(peer))
  apply(rib, makeProtocolOpen(peer))
  return { rib, peer }
}

// ---------------------------------------------------------------------------
// Peer lifecycle
// ---------------------------------------------------------------------------

describe('Peer lifecycle', () => {
  it('LocalPeerCreate adds peer with initializing status and default holdTime', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    const plan = apply(rib, makeLocalPeerCreate(peer))

    expect(plan.prevState).not.toBe(plan.newState)
    const added = rib.state.internal.peers.find((p) => p.name === 'peer-b')
    expect(added).toBeDefined()
    expect(added!.connectionStatus).toBe('initializing')
    expect(added!.holdTime).toBe(90_000)
    expect(added!.lastSent).toBe(0)
    expect(added!.lastReceived).toBe(0)
  })

  it('LocalPeerCreate with duplicate name → no state change (prevState === newState)', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))

    const stateBeforeDuplicate = rib.state
    const plan = rib.plan(makeLocalPeerCreate(peer), rib.state)

    expect(plan.prevState).toBe(plan.newState)
    expect(plan.prevState).toBe(stateBeforeDuplicate)
  })

  it('LocalPeerUpdate modifies existing peer fields', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))

    const updatedPeer: PeerInfo = { ...peer, domains: ['updated.com'], labels: { env: 'prod' } }
    const plan = apply(rib, makeLocalPeerUpdate(updatedPeer))

    expect(plan.prevState).not.toBe(plan.newState)
    const found = rib.state.internal.peers.find((p) => p.name === 'peer-b')
    expect(found!.domains).toEqual(['updated.com'])
    expect(found!.labels).toEqual({ env: 'prod' })
  })

  it('LocalPeerUpdate preserves runtime-only fields (connectionStatus, holdTime, lastReceived)', () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    // Peer should now be connected with lastReceived > 0
    const connectedPeer = rib.state.internal.peers.find((p) => p.name === 'peer-b')!
    const originalStatus = connectedPeer.connectionStatus
    const originalHoldTime = connectedPeer.holdTime
    const originalLastReceived = connectedPeer.lastReceived

    const updatedPeer: PeerInfo = { ...peer, domains: ['new.com'] }
    apply(rib, makeLocalPeerUpdate(updatedPeer))

    const after = rib.state.internal.peers.find((p) => p.name === 'peer-b')!
    expect(after.connectionStatus).toBe(originalStatus)
    expect(after.holdTime).toBe(originalHoldTime)
    expect(after.lastReceived).toBe(originalLastReceived)
    expect(after.domains).toEqual(['new.com'])
  })

  it('LocalPeerUpdate with unknown peer → no state change', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const plan = rib.plan(makeLocalPeerUpdate(makePeer('unknown')), rib.state)
    expect(plan.prevState).toBe(plan.newState)
  })

  it('LocalPeerDelete removes peer from list', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))

    const plan = apply(rib, makeLocalPeerDelete('peer-b'))

    expect(plan.prevState).not.toBe(plan.newState)
    expect(rib.state.internal.peers.find((p) => p.name === 'peer-b')).toBeUndefined()
  })

  it('LocalPeerDelete removes all routes from that peer', () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    // Inject a route from peer-b
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route: makeRoute('svc-x'), nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )
    expect(rib.state.internal.routes.some((r) => r.peer.name === 'peer-b')).toBe(true)

    apply(rib, makeLocalPeerDelete('peer-b'))

    expect(rib.state.internal.routes.some((r) => r.peer.name === 'peer-b')).toBe(false)
  })

  it('LocalPeerDelete generates port release ops for routes with envoyPort', () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const routeWithPort = makeRoute('svc-x', { envoyPort: 10000 })
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route: routeWithPort, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    const plan = apply(rib, makeLocalPeerDelete('peer-b'))

    expect(plan.portOps).toHaveLength(1)
    expect(plan.portOps[0]).toEqual({ type: 'release', routeKey: 'svc-x', port: 10000 })
  })

  it('LocalPeerDelete with unknown peer → no state change', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const plan = rib.plan(makeLocalPeerDelete('nonexistent'), rib.state)
    expect(plan.prevState).toBe(plan.newState)
  })
})

// ---------------------------------------------------------------------------
// Route lifecycle
// ---------------------------------------------------------------------------

describe('Route lifecycle', () => {
  it('LocalRouteCreate adds route to local.routes', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const route = makeRoute('my-svc')
    const plan = apply(rib, makeLocalRouteCreate(route))

    expect(plan.prevState).not.toBe(plan.newState)
    expect(rib.state.local.routes.find((r) => r.name === 'my-svc')).toBeDefined()
  })

  it('LocalRouteCreate emits added routeChange', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const route = makeRoute('my-svc')
    const plan = apply(rib, makeLocalRouteCreate(route))

    expect(plan.routeChanges).toHaveLength(1)
    expect(plan.routeChanges[0].type).toBe('added')
  })

  it('LocalRouteCreate with duplicate name → no state change', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const route = makeRoute('my-svc')
    apply(rib, makeLocalRouteCreate(route))

    const plan = rib.plan(makeLocalRouteCreate(route), rib.state)
    expect(plan.prevState).toBe(plan.newState)
  })

  it('LocalRouteDelete removes route from local.routes', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const route = makeRoute('my-svc')
    apply(rib, makeLocalRouteCreate(route))

    const plan = apply(rib, makeLocalRouteDelete(route))

    expect(plan.prevState).not.toBe(plan.newState)
    expect(rib.state.local.routes.find((r) => r.name === 'my-svc')).toBeUndefined()
  })

  it('LocalRouteDelete generates port release op if route has envoyPort', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const route = makeRoute('my-svc', { envoyPort: 9000 })
    apply(rib, makeLocalRouteCreate(route))

    const plan = apply(rib, makeLocalRouteDelete(route))

    expect(plan.portOps).toHaveLength(1)
    expect(plan.portOps[0]).toEqual({ type: 'release', routeKey: 'my-svc', port: 9000 })
  })

  it('LocalRouteDelete does not generate portOps when no envoyPort', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const route = makeRoute('my-svc')
    apply(rib, makeLocalRouteCreate(route))

    const plan = apply(rib, makeLocalRouteDelete(route))

    expect(plan.portOps).toHaveLength(0)
  })

  it('LocalRouteDelete with unknown route → no state change', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const plan = rib.plan(makeLocalRouteDelete(makeRoute('nonexistent')), rib.state)
    expect(plan.prevState).toBe(plan.newState)
  })
})

// ---------------------------------------------------------------------------
// BGP propagation (state only)
// ---------------------------------------------------------------------------

describe('BGP propagation via InternalProtocolUpdate', () => {
  it("'add' stores route with correct peer, nodePath, originNode", () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-1')

    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    const stored = rib.state.internal.routes.find((r) => r.name === 'svc-1')
    expect(stored).toBeDefined()
    expect(stored!.peer.name).toBe('peer-b')
    expect(stored!.nodePath).toEqual(['peer-b'])
    expect(stored!.originNode).toBe('peer-b')
    expect(stored!.isStale).toBe(false)
  })

  it("'add' with loop (nodeId in nodePath) → skipped, no route added", () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-loop')

    // nodePath includes 'node-a' which is this node's ID — should be dropped
    const plan = apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['node-a', 'peer-b'], originNode: 'peer-b' },
      ])
    )

    expect(rib.state.internal.routes.find((r) => r.name === 'svc-loop')).toBeUndefined()
    // routeChanges should be empty (route was skipped)
    expect(plan.routeChanges).toHaveLength(0)
  })

  it("'remove' deletes route by (name, originNode)", () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-1')

    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )
    expect(rib.state.internal.routes.find((r) => r.name === 'svc-1')).toBeDefined()

    const plan = apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'remove', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    expect(rib.state.internal.routes.find((r) => r.name === 'svc-1')).toBeUndefined()
    expect(plan.routeChanges.some((c) => c.type === 'removed')).toBe(true)
  })

  it("'remove' generates release portOp for route with envoyPort", () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-1', { envoyPort: 10001 })

    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    const plan = apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'remove', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    expect(plan.portOps).toHaveLength(1)
    expect(plan.portOps[0]).toEqual({ type: 'release', routeKey: 'svc-1', port: 10001 })
  })

  it('resets lastReceived on sending peer', () => {
    const fixedNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow)

    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-1')

    vi.spyOn(Date, 'now').mockReturnValue(fixedNow + 5000)
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    const found = rib.state.internal.peers.find((p) => p.name === 'peer-b')
    expect(found!.lastReceived).toBe(fixedNow + 5000)

    vi.restoreAllMocks()
  })

  it("'add' with shorter path replaces existing (best-path selection)", () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-1')

    // First: longer path (2 hops)
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-c', 'peer-b'], originNode: 'peer-c' },
      ])
    )
    const first = rib.state.internal.routes.find((r) => r.name === 'svc-1')
    expect(first!.nodePath).toHaveLength(2)

    // Second: shorter path (1 hop) — should replace
    const plan = apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-c' },
      ])
    )

    const updated = rib.state.internal.routes.find((r) => r.name === 'svc-1')
    expect(updated!.nodePath).toHaveLength(1)
    expect(plan.routeChanges.some((c) => c.type === 'updated')).toBe(true)
  })

  it("'add' with longer path does NOT replace existing", () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-1')

    // First: 1-hop path
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    // Second: 2-hop path — should NOT replace
    const plan = apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-c', 'peer-b'], originNode: 'peer-b' },
      ])
    )

    const stored = rib.state.internal.routes.find((r) => r.name === 'svc-1')
    expect(stored!.nodePath).toHaveLength(1)
    // No route changes should be emitted for a rejected longer path
    expect(plan.routeChanges).toHaveLength(0)
  })

  it('handles batch update with many routes in a single message', () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')

    // Build a batch of 15 route advertisements in a single update
    const updates = Array.from({ length: 15 }, (_, i) => ({
      action: 'add' as const,
      route: makeRoute(`batch-svc-${i}`),
      nodePath: ['peer-b'],
      originNode: 'peer-b',
    }))

    const plan = apply(rib, makeProtocolUpdate(peer, updates))

    // All 15 routes should be installed
    const installed = rib.state.internal.routes.filter((r) => r.name.startsWith('batch-svc-'))
    expect(installed).toHaveLength(15)
    expect(plan.routeChanges).toHaveLength(15)
    expect(plan.routeChanges.every((c) => c.type === 'added')).toBe(true)
  })

  it('batch update with mixed adds and removes processes all operations', () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')

    // Pre-install 5 routes
    const seedRoutes = Array.from({ length: 5 }, (_, i) => ({
      action: 'add' as const,
      route: makeRoute(`existing-${i}`),
      nodePath: ['peer-b'],
      originNode: 'peer-b',
    }))
    apply(rib, makeProtocolUpdate(peer, seedRoutes))
    expect(rib.state.internal.routes).toHaveLength(5)

    // Single batch: remove 3 existing + add 7 new
    const batchUpdates = [
      ...Array.from({ length: 3 }, (_, i) => ({
        action: 'remove' as const,
        route: makeRoute(`existing-${i}`),
        nodePath: ['peer-b'],
        originNode: 'peer-b',
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        action: 'add' as const,
        route: makeRoute(`new-${i}`),
        nodePath: ['peer-b'],
        originNode: 'peer-b',
      })),
    ]

    const plan = apply(rib, makeProtocolUpdate(peer, batchUpdates))

    // 5 existing - 3 removed + 7 new = 9 routes
    expect(rib.state.internal.routes).toHaveLength(9)
    expect(plan.routeChanges).toHaveLength(10) // 3 removed + 7 added

    const removals = plan.routeChanges.filter((c) => c.type === 'removed')
    const additions = plan.routeChanges.filter((c) => c.type === 'added')
    expect(removals).toHaveLength(3)
    expect(additions).toHaveLength(7)
  })

  it('batch update skips looped routes while processing valid ones', () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')

    const batchUpdates = [
      {
        action: 'add' as const,
        route: makeRoute('valid-1'),
        nodePath: ['peer-b'],
        originNode: 'peer-b',
      },
      {
        action: 'add' as const,
        route: makeRoute('looped'),
        nodePath: ['node-a', 'peer-b'],
        originNode: 'peer-b',
      },
      {
        action: 'add' as const,
        route: makeRoute('valid-2'),
        nodePath: ['peer-b'],
        originNode: 'peer-b',
      },
    ]

    const plan = apply(rib, makeProtocolUpdate(peer, batchUpdates))

    // Only 2 valid routes installed, looped one skipped
    expect(rib.state.internal.routes).toHaveLength(2)
    expect(rib.state.internal.routes.map((r) => r.name).sort()).toEqual(['valid-1', 'valid-2'])
    expect(plan.routeChanges).toHaveLength(2)
  })

  it("'add' replaces stale route regardless of path length", () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-1')

    // Add route then mark it stale via TRANSPORT_ERROR close
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )
    apply(rib, makeProtocolClose(peer, CloseCodes.TRANSPORT_ERROR))

    // Reopen and readvertise with longer path
    apply(rib, makeProtocolOpen(peer))
    const plan = apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-c', 'peer-b'], originNode: 'peer-b' },
      ])
    )

    const stored = rib.state.internal.routes.find((r) => r.name === 'svc-1')
    expect(stored).toBeDefined()
    expect(stored!.isStale).toBe(false)
    expect(plan.routeChanges.some((c) => c.type === 'updated')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Peer connection
// ---------------------------------------------------------------------------

describe('Peer connection', () => {
  it('InternalProtocolOpen with unknown peer → no state change', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const plan = rib.plan(makeProtocolOpen(makePeer('unknown')), rib.state)
    expect(plan.prevState).toBe(plan.newState)
  })

  it('InternalProtocolOpen sets connectionStatus to connected and updates lastReceived', () => {
    const fixedNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow)

    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))
    apply(rib, makeProtocolOpen(peer))

    const found = rib.state.internal.peers.find((p) => p.name === 'peer-b')!
    expect(found.connectionStatus).toBe('connected')
    expect(found.lastReceived).toBe(fixedNow)

    vi.restoreAllMocks()
  })

  it('InternalProtocolOpen negotiates holdTime as min of local and remote', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))
    // Default holdTime is 90_000 ms. Remote offers 30_000 ms — should take min.
    apply(rib, makeProtocolOpen(peer, 30_000))

    const found = rib.state.internal.peers.find((p) => p.name === 'peer-b')!
    expect(found.holdTime).toBe(30_000)
  })

  it('InternalProtocolOpen keeps local holdTime when remote offers higher', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))
    // Local default 90_000, remote offers 120_000 — should keep 90_000
    apply(rib, makeProtocolOpen(peer, 120_000))

    const found = rib.state.internal.peers.find((p) => p.name === 'peer-b')!
    expect(found.holdTime).toBe(90_000)
  })

  it('InternalProtocolOpen with no holdTime keeps local holdTime', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))
    apply(rib, makeProtocolOpen(peer, undefined))

    const found = rib.state.internal.peers.find((p) => p.name === 'peer-b')!
    expect(found.holdTime).toBe(90_000)
  })

  it('InternalProtocolConnected sets connected status, lastConnected, and lastReceived', () => {
    const fixedNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow)

    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))
    apply(rib, makeProtocolConnected(peer))

    const found = rib.state.internal.peers.find((p) => p.name === 'peer-b')!
    expect(found.connectionStatus).toBe('connected')
    expect(found.lastConnected).toBe(fixedNow)
    expect(found.lastReceived).toBe(fixedNow)

    vi.restoreAllMocks()
  })

  it('InternalProtocolConnected resets holdTime and lastSent for re-negotiation', () => {
    const fixedNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow)

    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))
    // Negotiate holdTime down to 30s via Open
    apply(rib, makeProtocolOpen(peer, 30_000))

    const afterOpen = rib.state.internal.peers.find((p) => p.name === 'peer-b')!
    expect(afterOpen.holdTime).toBe(30_000)

    // Simulate disconnect + reconnect
    apply(rib, makeProtocolClose(peer, CloseCodes.TRANSPORT_ERROR))
    apply(rib, makeProtocolConnected(peer))

    const afterReconnect = rib.state.internal.peers.find((p) => p.name === 'peer-b')!
    // holdTime should be reset to default so it can be re-negotiated
    expect(afterReconnect.holdTime).toBe(90_000)
    expect(afterReconnect.lastSent).toBe(0)
    expect(afterReconnect.lastConnected).toBe(fixedNow)

    vi.restoreAllMocks()
  })

  it('InternalProtocolConnected with unknown peer → no state change', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const plan = rib.plan(makeProtocolConnected(makePeer('unknown')), rib.state)
    expect(plan.prevState).toBe(plan.newState)
  })

  it('InternalProtocolClose with NORMAL code removes routes', () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-1')
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    apply(rib, makeProtocolClose(peer, CloseCodes.NORMAL))

    expect(rib.state.internal.routes.find((r) => r.name === 'svc-1')).toBeUndefined()
    expect(rib.state.internal.peers.find((p) => p.name === 'peer-b')!.connectionStatus).toBe(
      'closed'
    )
  })

  it('InternalProtocolClose with TRANSPORT_ERROR marks routes isStale=true', () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-1')
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    const plan = apply(rib, makeProtocolClose(peer, CloseCodes.TRANSPORT_ERROR))

    const stale = rib.state.internal.routes.find((r) => r.name === 'svc-1')
    expect(stale).toBeDefined()
    expect(stale!.isStale).toBe(true)
    // No port ops for graceful restart
    expect(plan.portOps).toHaveLength(0)
    expect(plan.routeChanges.some((c) => c.type === 'updated')).toBe(true)
  })

  it('InternalProtocolClose with HOLD_EXPIRED removes routes', () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-2')
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    apply(rib, makeProtocolClose(peer, CloseCodes.HOLD_EXPIRED))

    expect(rib.state.internal.routes.find((r) => r.name === 'svc-2')).toBeUndefined()
  })

  it('InternalProtocolClose with ADMIN_SHUTDOWN removes routes', () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-3')
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    apply(rib, makeProtocolClose(peer, CloseCodes.ADMIN_SHUTDOWN))

    expect(rib.state.internal.routes.find((r) => r.name === 'svc-3')).toBeUndefined()
  })

  it('InternalProtocolClose generates port release ops for removed routes', () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-1', { envoyPort: 9001 })
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    const plan = apply(rib, makeProtocolClose(peer, CloseCodes.NORMAL))

    expect(plan.portOps).toHaveLength(1)
    expect(plan.portOps[0]).toEqual({ type: 'release', routeKey: 'svc-1', port: 9001 })
  })

  it('InternalProtocolClose with TRANSPORT_ERROR does NOT generate port ops', () => {
    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const route = makeRoute('svc-1', { envoyPort: 9002 })
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    const plan = apply(rib, makeProtocolClose(peer, CloseCodes.TRANSPORT_ERROR))

    expect(plan.portOps).toHaveLength(0)
  })

  it('InternalProtocolClose with unknown peer → no state change', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const plan = rib.plan(makeProtocolClose(makePeer('ghost'), CloseCodes.NORMAL), rib.state)
    expect(plan.prevState).toBe(plan.newState)
  })
})

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

describe('Tick', () => {
  it('Tick with no expired peers → prevState === newState (reference equal)', () => {
    const { rib } = ribWithConnectedPeer('node-a', 'peer-b')
    // Peer was just connected, hold timer has not expired
    const plan = rib.plan(makeTick(Date.now()), rib.state)
    expect(plan.prevState).toBe(plan.newState)
  })

  it('Tick expires peer past holdTime → removes routes and marks peer closed', () => {
    const baseNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(baseNow)

    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))
    // Open with a short holdTime so it expires quickly
    apply(rib, makeProtocolOpen(peer, 10_000))

    const route = makeRoute('svc-1')
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    vi.restoreAllMocks()

    // Now tick at baseNow + 11_000 ms — past the 10s holdTime
    const plan = apply(rib, makeTick(baseNow + 11_000))

    expect(plan.prevState).not.toBe(plan.newState)
    expect(rib.state.internal.routes.find((r) => r.name === 'svc-1')).toBeUndefined()
    expect(rib.state.internal.peers.find((p) => p.name === 'peer-b')!.connectionStatus).toBe(
      'closed'
    )
  })

  it('Tick generates port release ops for expired peer routes', () => {
    const baseNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(baseNow)

    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))
    apply(rib, makeProtocolOpen(peer, 10_000))

    const route = makeRoute('svc-1', { envoyPort: 9003 })
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    vi.restoreAllMocks()

    const plan = apply(rib, makeTick(baseNow + 11_000))

    expect(plan.portOps).toHaveLength(1)
    expect(plan.portOps[0]).toEqual({ type: 'release', routeKey: 'svc-1', port: 9003 })
  })

  it('Tick ignores peers with holdTime === 0', () => {
    // A peer with holdTime=0 should never expire
    const baseNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(baseNow)

    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))
    // Force holdTime to 0 via negotiation (open with holdTime=0 would set min to 0)
    // We achieve this by not opening and manually constructing state
    apply(rib, makeProtocolOpen(peer, 0))

    vi.restoreAllMocks()

    // Even far in the future, should not expire
    const plan = rib.plan(makeTick(baseNow + 999_999_999), rib.state)
    expect(plan.prevState).toBe(plan.newState)
  })

  it('Tick ignores peers with lastReceived === 0 (never received anything)', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))
    // Peer exists in initializing state, lastReceived=0

    // Tick far in the future — should not expire since lastReceived===0
    const plan = rib.plan(makeTick(Date.now() + 999_999_999), rib.state)
    expect(plan.prevState).toBe(plan.newState)
  })

  it('Tick ignores closed peers with no stale routes (normal close)', () => {
    const baseNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(baseNow)

    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    // Close the peer normally — routes are removed, not stale
    apply(rib, makeProtocolClose(peer, CloseCodes.NORMAL))
    expect(rib.state.internal.peers.find((p) => p.name === 'peer-b')!.connectionStatus).toBe(
      'closed'
    )

    vi.restoreAllMocks()

    // Tick should not do anything — no stale routes to purge
    const plan = rib.plan(makeTick(baseNow + 999_999_999), rib.state)
    expect(plan.prevState).toBe(plan.newState)
  })

  it('Tick purges stale routes from closed peers after holdTime grace period', () => {
    const baseNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(baseNow)

    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))
    apply(rib, makeProtocolOpen(peer, 10_000))

    const route = makeRoute('svc-1')
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    // Transport error — routes become stale, peer set to closed
    apply(rib, makeProtocolClose(peer, CloseCodes.TRANSPORT_ERROR))
    expect(rib.state.internal.routes.find((r) => r.name === 'svc-1')?.isStale).toBe(true)
    expect(rib.state.internal.peers.find((p) => p.name === 'peer-b')!.connectionStatus).toBe(
      'closed'
    )

    vi.restoreAllMocks()

    // Tick before holdTime elapses — stale routes should survive (grace period)
    const earlyPlan = rib.plan(makeTick(baseNow + 9_000), rib.state)
    expect(earlyPlan.prevState).toBe(earlyPlan.newState)

    // Tick after holdTime elapses — stale routes should be purged
    const plan = apply(rib, makeTick(baseNow + 11_000))
    expect(rib.state.internal.routes.find((r) => r.name === 'svc-1')).toBeUndefined()
    expect(plan.routeChanges).toHaveLength(1)
    expect(plan.routeChanges[0].type).toBe('removed')
  })

  it('Tick releases envoy ports when purging stale routes', () => {
    const baseNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(baseNow)

    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))
    apply(rib, makeProtocolOpen(peer, 10_000))

    const route = makeRoute('svc-1', { envoyPort: 9005 })
    apply(
      rib,
      makeProtocolUpdate(peer, [
        { action: 'add', route, nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )

    apply(rib, makeProtocolClose(peer, CloseCodes.TRANSPORT_ERROR))
    vi.restoreAllMocks()

    const plan = apply(rib, makeTick(baseNow + 11_000))
    expect(plan.portOps).toHaveLength(1)
    expect(plan.portOps[0]).toEqual({ type: 'release', routeKey: 'svc-1', port: 9005 })
  })
})

// ---------------------------------------------------------------------------
// Keepalive
// ---------------------------------------------------------------------------

describe('Keepalive', () => {
  it('InternalProtocolKeepalive updates lastReceived on peer', () => {
    const baseNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(baseNow)

    const { rib, peer } = ribWithConnectedPeer('node-a', 'peer-b')
    const initialLastReceived = rib.state.internal.peers.find(
      (p) => p.name === 'peer-b'
    )!.lastReceived

    vi.spyOn(Date, 'now').mockReturnValue(baseNow + 30_000)
    const plan = apply(rib, makeProtocolKeepalive(peer))

    expect(plan.prevState).not.toBe(plan.newState)
    const found = rib.state.internal.peers.find((p) => p.name === 'peer-b')!
    expect(found.lastReceived).toBe(baseNow + 30_000)
    expect(found.lastReceived).toBeGreaterThan(initialLastReceived)

    vi.restoreAllMocks()
  })

  it('InternalProtocolKeepalive with unknown peer → no state change', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const plan = rib.plan(makeProtocolKeepalive(makePeer('unknown')), rib.state)
    expect(plan.prevState).toBe(plan.newState)
  })

  it('InternalProtocolKeepalive resets hold timer to prevent expiry', () => {
    const baseNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(baseNow)

    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    apply(rib, makeLocalPeerCreate(peer))
    apply(rib, makeProtocolOpen(peer, 10_000))

    // Keepalive arrives just before expiry
    vi.spyOn(Date, 'now').mockReturnValue(baseNow + 9_000)
    apply(rib, makeProtocolKeepalive(peer))

    vi.restoreAllMocks()

    // Tick at +10_000 from original, but only +1000 from keepalive — should NOT expire
    const plan = rib.plan(makeTick(baseNow + 10_000), rib.state)
    expect(plan.prevState).toBe(plan.newState)
  })
})

// ---------------------------------------------------------------------------
// Plan purity
// ---------------------------------------------------------------------------

describe('Plan purity', () => {
  it('plan() does not mutate input state', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const state = newRouteTable()

    // Deep-freeze the state object to catch any mutations
    const frozen = Object.freeze({
      ...state,
      local: Object.freeze({ ...state.local, routes: Object.freeze([...state.local.routes]) }),
      internal: Object.freeze({
        ...state.internal,
        peers: Object.freeze([...state.internal.peers]),
        routes: Object.freeze([...state.internal.routes]),
      }),
    }) as RouteTable

    const peer = makePeer('peer-b')
    expect(() => rib.plan(makeLocalPeerCreate(peer), frozen)).not.toThrow()
  })

  it('plan() with same inputs produces same structural output', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peer = makePeer('peer-b')
    const state = newRouteTable()
    const action = makeLocalPeerCreate(peer)

    const plan1 = rib.plan(action, state)
    const plan2 = rib.plan(action, state)

    // Both plans should produce structurally equivalent state
    expect(plan1.newState.internal.peers[0].name).toBe(plan2.newState.internal.peers[0].name)
    expect(plan1.newState.internal.peers[0].connectionStatus).toBe(
      plan2.newState.internal.peers[0].connectionStatus
    )
  })

  it('rejected action: prevState === newState reference equality', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })

    // Delete nonexistent peer — should be a no-op
    const plan = rib.plan(makeLocalPeerDelete('ghost'), rib.state)
    expect(plan.prevState).toBe(plan.newState)

    // Create duplicate local route — should be a no-op
    apply(rib, makeLocalRouteCreate(makeRoute('svc-1')))
    const plan2 = rib.plan(makeLocalRouteCreate(makeRoute('svc-1')), rib.state)
    expect(plan2.prevState).toBe(plan2.newState)
  })

  it('stateChanged() returns false when prevState === newState', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const plan = rib.plan(makeLocalPeerDelete('ghost'), rib.state)
    expect(rib.stateChanged(plan)).toBe(false)
  })

  it('stateChanged() returns true when state changed', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const plan = rib.plan(makeLocalPeerCreate(makePeer('peer-b')), rib.state)
    expect(rib.stateChanged(plan)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Journal integration
// ---------------------------------------------------------------------------

describe('Journal integration', () => {
  it('commit() with InMemoryActionLog appends when state changed', () => {
    const journal = new InMemoryActionLog()
    const rib = new RoutingInformationBase({ nodeId: 'node-a', journal })

    const action = makeLocalPeerCreate(makePeer('peer-b'))
    const plan = rib.plan(action, rib.state)
    rib.commit(plan, action)

    expect(journal.lastSeq()).toBe(1)
    expect(journal.replay()[0].action).toEqual(action)
  })

  it('commit() does NOT append to journal when state unchanged (rejected action)', () => {
    const journal = new InMemoryActionLog()
    const rib = new RoutingInformationBase({ nodeId: 'node-a', journal })

    // Attempt to delete a nonexistent peer — should be no-op
    const action = makeLocalPeerDelete('ghost')
    const plan = rib.plan(action, rib.state)
    rib.commit(plan, action)

    expect(journal.lastSeq()).toBe(0)
    expect(journal.replay()).toHaveLength(0)
  })

  it('state rebuilt from journal replay matches live state after multiple actions', () => {
    const journal = new InMemoryActionLog()
    const rib = new RoutingInformationBase({ nodeId: 'node-a', journal })

    const peer = makePeer('peer-b')
    const route = makeRoute('svc-1')

    apply(rib, makeLocalPeerCreate(peer))
    apply(rib, makeProtocolOpen(peer))
    apply(rib, makeLocalRouteCreate(route))

    // Replay journal into a fresh RIB
    const entries = journal.replay()
    const freshRib = new RoutingInformationBase({ nodeId: 'node-a' })
    for (const entry of entries) {
      const plan = freshRib.plan(entry.action, freshRib.state)
      freshRib.commit(plan, entry.action)
    }

    // Local routes should match
    expect(freshRib.state.local.routes).toHaveLength(rib.state.local.routes.length)
    expect(freshRib.state.local.routes[0].name).toBe(rib.state.local.routes[0].name)

    // Internal peers should match in name and status
    expect(freshRib.state.internal.peers).toHaveLength(rib.state.internal.peers.length)
    expect(freshRib.state.internal.peers[0].name).toBe(rib.state.internal.peers[0].name)
    expect(freshRib.state.internal.peers[0].connectionStatus).toBe(
      rib.state.internal.peers[0].connectionStatus
    )
  })

  it('commit() appends the correct nodeId to journal entries', () => {
    const journal = new InMemoryActionLog()
    const rib = new RoutingInformationBase({ nodeId: 'my-node', journal })

    const action = makeLocalPeerCreate(makePeer('peer-b'))
    const plan = rib.plan(action, rib.state)
    rib.commit(plan, action)

    const entries = journal.replay()
    expect(entries[0].nodeId).toBe('my-node')
  })

  it('commit() does not journal duplicate actions', () => {
    const journal = new InMemoryActionLog()
    const rib = new RoutingInformationBase({ nodeId: 'node-a', journal })
    const peer = makePeer('peer-b')

    apply(rib, makeLocalPeerCreate(peer))
    // Second create is a no-op
    apply(rib, makeLocalPeerCreate(peer))

    // Only 1 entry should be in the journal
    expect(journal.lastSeq()).toBe(1)
  })

  it('commit() updates internal state regardless of journal', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' }) // no journal
    const peer = makePeer('peer-b')

    apply(rib, makeLocalPeerCreate(peer))

    expect(rib.state.internal.peers).toHaveLength(1)
    expect(rib.state.internal.peers[0].name).toBe('peer-b')
  })
})

// ---------------------------------------------------------------------------
// Multi-peer scenarios
// ---------------------------------------------------------------------------

describe('Multi-peer scenarios', () => {
  it('routes from different peers coexist independently', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peerB = makePeer('peer-b')
    const peerC = makePeer('peer-c')

    apply(rib, makeLocalPeerCreate(peerB))
    apply(rib, makeLocalPeerCreate(peerC))
    apply(rib, makeProtocolOpen(peerB))
    apply(rib, makeProtocolOpen(peerC))

    apply(
      rib,
      makeProtocolUpdate(peerB, [
        { action: 'add', route: makeRoute('svc-b'), nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )
    apply(
      rib,
      makeProtocolUpdate(peerC, [
        { action: 'add', route: makeRoute('svc-c'), nodePath: ['peer-c'], originNode: 'peer-c' },
      ])
    )

    expect(rib.state.internal.routes).toHaveLength(2)

    // Closing peer-b should only remove svc-b
    apply(rib, makeProtocolClose(peerB, CloseCodes.NORMAL))

    expect(rib.state.internal.routes).toHaveLength(1)
    expect(rib.state.internal.routes[0].name).toBe('svc-c')
  })

  it('LocalPeerDelete does not affect routes from other peers', () => {
    const rib = new RoutingInformationBase({ nodeId: 'node-a' })
    const peerB = makePeer('peer-b')
    const peerC = makePeer('peer-c')

    apply(rib, makeLocalPeerCreate(peerB))
    apply(rib, makeLocalPeerCreate(peerC))
    apply(rib, makeProtocolOpen(peerB))
    apply(rib, makeProtocolOpen(peerC))

    apply(
      rib,
      makeProtocolUpdate(peerB, [
        { action: 'add', route: makeRoute('svc-b'), nodePath: ['peer-b'], originNode: 'peer-b' },
      ])
    )
    apply(
      rib,
      makeProtocolUpdate(peerC, [
        { action: 'add', route: makeRoute('svc-c'), nodePath: ['peer-c'], originNode: 'peer-c' },
      ])
    )

    apply(rib, makeLocalPeerDelete('peer-b'))

    expect(rib.state.internal.peers).toHaveLength(1)
    expect(rib.state.internal.peers[0].name).toBe('peer-c')
    expect(rib.state.internal.routes).toHaveLength(1)
    expect(rib.state.internal.routes[0].name).toBe('svc-c')
  })
})

// ---------------------------------------------------------------------------
// initialState option
// ---------------------------------------------------------------------------

describe('initialState option', () => {
  it('uses provided initialState instead of empty table', () => {
    const preset = newRouteTable()
    preset.local.routes.push(makeRoute('pre-existing'))

    const rib = new RoutingInformationBase({ nodeId: 'node-a', initialState: preset })

    expect(rib.state.local.routes).toHaveLength(1)
    expect(rib.state.local.routes[0].name).toBe('pre-existing')
  })
})
