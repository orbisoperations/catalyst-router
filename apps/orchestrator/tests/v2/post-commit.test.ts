import { describe, it, expect, beforeEach } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions, CloseCodes } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo, PeerRecord, InternalRoute, RoutePolicy } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const configA: OrchestratorConfig = {
  node: { name: 'node-a', endpoint: 'ws://node-a:4000', domains: ['example.local'] },
}

const peerBInfo: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['example.local'],
}
const peerCInfo: PeerInfo = {
  name: 'node-c',
  endpoint: 'ws://node-c:4000',
  domains: ['example.local'],
}

const routeAlpha = { name: 'alpha', protocol: 'http' as const, endpoint: 'http://alpha:8080' }
const routeBeta = { name: 'beta', protocol: 'http' as const, endpoint: 'http://beta:8080' }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Connect a peer to a bus (LocalPeerCreate + InternalProtocolConnected). */
async function connectPeer(bus: OrchestratorBus, peerInfo: PeerInfo): Promise<void> {
  await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
  await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo } })
}

/** Build a synthetic InternalRoute as if received from a peer. */
function _makeInternalRoute(
  route: { name: string; protocol: 'http'; endpoint: string },
  peer: PeerInfo,
  nodePath: string[],
  originNode: string
): InternalRoute {
  return {
    ...route,
    peer,
    nodePath,
    originNode,
    isStale: false,
  }
}

/** Deny-all route policy for testing policy filter. */
class DenyAllPolicy implements RoutePolicy {
  canSend(_peer: PeerRecord, _routes: InternalRoute[]): InternalRoute[] {
    return []
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Post-commit BGP notification — route changes', () => {
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(async () => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config: configA, transport })
  })

  it('local route add sends update to all connected peers', async () => {
    await connectPeer(bus, peerBInfo)
    await connectPeer(bus, peerCInfo)
    transport.reset()

    await bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })

    const updateCalls = transport.getCallsFor('sendUpdate')
    expect(updateCalls).toHaveLength(2)
    const peerNames = updateCalls.map((c) => (c.method === 'sendUpdate' ? c.peer.name : ''))
    expect(peerNames).toContain('node-b')
    expect(peerNames).toContain('node-c')
  })

  it('local route add does not send to disconnected peers', async () => {
    // Create peer B (initializing) but do NOT fire InternalProtocolConnected
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerBInfo })
    transport.reset()

    await bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })

    expect(transport.getCallsFor('sendUpdate')).toHaveLength(0)
  })

  it('internal route add is not reflected back to source peer', async () => {
    // A peers with B and C
    await connectPeer(bus, peerBInfo)
    await connectPeer(bus, peerCInfo)
    transport.reset()

    // Receive update from B (B is the source)
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerBInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: routeAlpha,
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    const updateCalls = transport.getCallsFor('sendUpdate')
    // Must not send back to B (the source), only to C
    const sentToPeers = updateCalls.map((c) => (c.method === 'sendUpdate' ? c.peer.name : ''))
    expect(sentToPeers).not.toContain('node-b')
    expect(sentToPeers).toContain('node-c')
  })

  it('internal route add is not sent to peers already in nodePath (loop guard)', async () => {
    await connectPeer(bus, peerBInfo)
    await connectPeer(bus, peerCInfo)
    transport.reset()

    // Receive a route whose nodePath already includes node-c
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerBInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: routeAlpha,
              // node-c is in the path — must not forward to C
              nodePath: ['node-b', 'node-c'],
              originNode: 'node-c',
            },
          ],
        },
      },
    })

    const updateCalls = transport.getCallsFor('sendUpdate')
    const sentToPeers = updateCalls.map((c) => (c.method === 'sendUpdate' ? c.peer.name : ''))
    expect(sentToPeers).not.toContain('node-c')
  })

  it('withdrawal (route delete) is sent to all connected peers', async () => {
    await connectPeer(bus, peerBInfo)
    await connectPeer(bus, peerCInfo)
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })
    transport.reset()

    await bus.dispatch({ action: Actions.LocalRouteDelete, data: routeAlpha })

    const updateCalls = transport.getCallsFor('sendUpdate')
    expect(updateCalls).toHaveLength(2)
    for (const call of updateCalls) {
      if (call.method !== 'sendUpdate') continue
      expect(call.message.updates[0].action).toBe('remove')
      expect(call.message.updates[0].route.name).toBe('alpha')
    }
  })

  it('route updates prepend nodeId to nodePath when forwarding internal routes', async () => {
    await connectPeer(bus, peerBInfo)
    await connectPeer(bus, peerCInfo)
    transport.reset()

    // Receive route from B with nodePath ['node-b']
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerBInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: routeAlpha,
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    const updateCalls = transport.getCallsFor('sendUpdate')
    // Should forward to C (not B)
    const callToC = updateCalls.find((c) => c.method === 'sendUpdate' && c.peer.name === 'node-c')
    expect(callToC).toBeDefined()
    if (callToC?.method !== 'sendUpdate') return
    // node-a (this node) prepends itself: ['node-a', 'node-b']
    expect(callToC.message.updates[0].nodePath).toEqual(['node-a', 'node-b'])
  })

  it('route updates include originNode from the received advertisement', async () => {
    await connectPeer(bus, peerBInfo)
    await connectPeer(bus, peerCInfo)
    transport.reset()

    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerBInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: routeAlpha,
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    const callToC = transport
      .getCallsFor('sendUpdate')
      .find((c) => c.method === 'sendUpdate' && c.peer.name === 'node-c')
    expect(callToC).toBeDefined()
    if (callToC?.method !== 'sendUpdate') return
    expect(callToC.message.updates[0].originNode).toBe('node-b')
  })

  it('local route advertisements set originNode to this nodeId', async () => {
    await connectPeer(bus, peerBInfo)
    transport.reset()

    await bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })

    const callToB = transport.getCallsFor('sendUpdate')[0]
    if (callToB?.method !== 'sendUpdate') throw new Error('no call')
    expect(callToB.message.updates[0].originNode).toBe('node-a')
    expect(callToB.message.updates[0].nodePath).toEqual(['node-a'])
  })

  it('fanOut failure on one peer does not affect delivery to other peers', async () => {
    await connectPeer(bus, peerBInfo)
    await connectPeer(bus, peerCInfo)
    transport.reset()

    // Fail the first sendUpdate call but succeed the second
    let callCount = 0
    const original = transport.sendUpdate.bind(transport)
    transport.sendUpdate = async (peer, msg) => {
      callCount++
      if (callCount === 1) throw new Error('first peer failure')
      return original(peer, msg)
    }

    // Should not throw despite one peer failing
    await expect(
      bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })
    ).resolves.toMatchObject({ success: true })

    // Second peer still received the update
    expect(callCount).toBe(2)
  })

  it('route policy filter prevents send when canSend returns empty', async () => {
    const policyTransport = new MockPeerTransport()
    const busWithPolicy = new OrchestratorBus({
      config: configA,
      transport: policyTransport,
      routePolicy: new DenyAllPolicy(),
    })

    await connectPeer(busWithPolicy, peerBInfo)

    // Inject an internal route via dispatch so the policy filter is exercised
    // The internal route from B gets blocked by the deny-all policy when forwarding to C
    await busWithPolicy.dispatch({ action: Actions.LocalPeerCreate, data: peerCInfo })
    await busWithPolicy.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerCInfo },
    })
    policyTransport.reset()

    // Receive an internal route from B — should be blocked by policy before forwarding to C
    await busWithPolicy.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerBInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: routeAlpha,
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    // Policy blocks forwarding: no sendUpdate calls to C
    const updateCalls = policyTransport.getCallsFor('sendUpdate')
    const sentToC = updateCalls.filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-c')
    expect(sentToC).toHaveLength(0)
  })
})

describe('Post-commit BGP notification — initial sync on InternalProtocolConnected', () => {
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(() => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config: configA, transport })
  })

  it('InternalProtocolConnected triggers full route sync to the connecting peer', async () => {
    // Add local routes before peer connects
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: routeBeta })
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerBInfo })
    transport.reset()

    // Now B connects — should trigger sync
    await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo: peerBInfo } })

    const updateCalls = transport.getCallsFor('sendUpdate')
    expect(updateCalls.length).toBeGreaterThanOrEqual(1)

    const allUpdates = updateCalls.flatMap((c) =>
      c.method === 'sendUpdate' ? c.message.updates : []
    )
    const routeNames = allUpdates.map((u) => u.route.name)
    expect(routeNames).toContain('alpha')
    expect(routeNames).toContain('beta')
    // All must be 'add' actions
    expect(allUpdates.every((u) => u.action === 'add')).toBe(true)
  })

  it('initial sync includes internal routes not already known by the connecting peer', async () => {
    // First connect C so A learns a route from C
    await connectPeer(bus, peerCInfo)
    transport.reset()

    // C advertises a route to A
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerCInfo,
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

    // Now B connects — A should sync the route from C to B
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerBInfo })
    transport.reset()
    await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo: peerBInfo } })

    const updateCalls = transport.getCallsFor('sendUpdate')
    const allUpdates = updateCalls.flatMap((c) =>
      c.method === 'sendUpdate' ? c.message.updates : []
    )
    const routeNames = allUpdates.map((u) => u.route.name)
    expect(routeNames).toContain('alpha')
  })

  it('initial sync excludes stale internal routes', async () => {
    // Connect C, learn a route, then disconnect with TRANSPORT_ERROR (marks stale)
    await connectPeer(bus, peerCInfo)
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerCInfo,
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

    // Transport error → routes marked stale
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: peerCInfo, code: CloseCodes.TRANSPORT_ERROR },
    })

    // Verify route is stale
    const staleRoute = bus.state.internal.routes.find((r) => r.name === 'alpha')
    expect(staleRoute?.isStale).toBe(true)

    // Now B connects — stale route must NOT be synced
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerBInfo })
    transport.reset()
    await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo: peerBInfo } })

    const updateCalls = transport.getCallsFor('sendUpdate')
    const allUpdates = updateCalls.flatMap((c) =>
      c.method === 'sendUpdate' ? c.message.updates : []
    )
    const routeNames = allUpdates.map((u) => u.route.name)
    expect(routeNames).not.toContain('alpha')
  })

  it("initial sync does not reflect a peer's own routes back at them", async () => {
    // B and C are both connected; A learns a route from B
    await connectPeer(bus, peerBInfo)
    await connectPeer(bus, peerCInfo)

    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerBInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: routeAlpha,
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })
    transport.reset()

    // Simulate B reconnecting (InternalProtocolConnected again after close)
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: peerBInfo, code: CloseCodes.NORMAL },
    })

    // Re-create and reconnect B
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerBInfo })
    transport.reset()
    await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo: peerBInfo } })

    // alpha came from B — must not be sent back to B during sync
    const updateCalls = transport.getCallsFor('sendUpdate')
    const sentToB = updateCalls.filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-b')
    const routeNames = sentToB.flatMap((c) =>
      c.method === 'sendUpdate' ? c.message.updates.map((u) => u.route.name) : []
    )
    expect(routeNames).not.toContain('alpha')
  })

  it('InternalProtocolOpen does NOT trigger route sync', async () => {
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerBInfo })
    transport.reset()

    // Open is not the same as connected — no sync
    await bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: peerBInfo },
    })

    expect(transport.getCallsFor('sendUpdate')).toHaveLength(0)
  })

  it('InternalProtocolConnected DOES trigger route sync', async () => {
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerBInfo })
    transport.reset()

    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerBInfo },
    })

    expect(transport.getCallsFor('sendUpdate').length).toBeGreaterThanOrEqual(1)
  })
})
