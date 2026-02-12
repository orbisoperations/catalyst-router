import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase, type Plan } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

const NODE: PeerInfo = {
  name: 'node-a.somebiz.local.io',
  endpoint: 'http://node-a:3000',
  domains: ['somebiz.local.io'],
}

const PEER_B: PeerInfo = {
  name: 'node-b.somebiz.local.io',
  endpoint: 'http://node-b:3000',
  domains: ['somebiz.local.io'],
  peerToken: 'token-for-b',
}

const PEER_C: PeerInfo = {
  name: 'node-c.somebiz.local.io',
  endpoint: 'http://node-c:3000',
  domains: ['somebiz.local.io'],
  peerToken: 'token-for-c',
}

const CONFIG: OrchestratorConfig = { node: NODE }

function createRib(config: OrchestratorConfig = CONFIG) {
  return new RoutingInformationBase(config)
}

/** Helper: plan + commit an action and return the commit result */
function planCommit(rib: RoutingInformationBase, action: Parameters<typeof rib.plan>[0]) {
  const plan = rib.plan(action)
  if (!plan.success) throw new Error(`plan failed: ${plan.error}`)
  return rib.commit(plan)
}

/** Helper: connect a peer (create + open) */
function connectPeer(rib: RoutingInformationBase, peer: PeerInfo) {
  planCommit(rib, { action: Actions.LocalPeerCreate, data: peer })
  planCommit(rib, { action: Actions.InternalProtocolOpen, data: { peerInfo: peer } })
}

describe('RoutingInformationBase', () => {
  describe('plan() purity', () => {
    it('does not mutate RIB state', () => {
      const rib = createRib()
      const stateBefore = rib.getState()

      const plan = rib.plan({
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })

      expect(plan.success).toBe(true)
      expect(rib.getState()).toBe(stateBefore)
      expect(rib.getState().local.routes).toHaveLength(0)
    })

    it('returns prevState equal to current state', () => {
      const rib = createRib()
      const stateBefore = rib.getState()

      const plan = rib.plan({
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })

      expect(plan.success).toBe(true)
      expect((plan as Plan).prevState).toBe(stateBefore)
    })

    it('computes newState without applying it', () => {
      const rib = createRib()

      const plan = rib.plan({
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })

      expect(plan.success).toBe(true)
      const p = plan as Plan
      expect(p.newState.local.routes).toHaveLength(1)
      expect(p.newState.local.routes[0].name).toBe('svc-a')
      // State not yet applied
      expect(rib.getState().local.routes).toHaveLength(0)
    })
  })

  describe('commit()', () => {
    it('applies newState from plan', () => {
      const rib = createRib()

      const plan = rib.plan({
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })
      expect(plan.success).toBe(true)

      const result = rib.commit(plan as Plan)
      expect(rib.getState().local.routes).toHaveLength(1)
      expect(rib.getState().local.routes[0].name).toBe('svc-a')
      expect(result.newState).toBe(rib.getState())
    })

    it('detects routesChanged when local routes change', () => {
      const rib = createRib()

      const plan = rib.plan({
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })

      const result = rib.commit(plan as Plan)
      expect(result.routesChanged).toBe(true)
    })

    it('detects routesChanged as false when only peers change', () => {
      const rib = createRib()

      const plan = rib.plan({
        action: Actions.LocalPeerCreate,
        data: PEER_B,
      })

      const result = rib.commit(plan as Plan)
      expect(result.routesChanged).toBe(false)
    })

    it('includes propagations from the plan', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      const plan = rib.plan({
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })

      const result = rib.commit(plan as Plan)
      expect(result.propagations).toHaveLength(1)
      expect(result.propagations[0].type).toBe('update')
    })
  })

  describe('state transitions', () => {
    it('LocalPeerCreate adds peer with initializing status', () => {
      const rib = createRib()
      planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })

      const peers = rib.getState().internal.peers
      expect(peers).toHaveLength(1)
      expect(peers[0].name).toBe(PEER_B.name)
      expect(peers[0].connectionStatus).toBe('initializing')
    })

    it('LocalPeerCreate fails without peerToken', () => {
      const rib = createRib()
      const plan = rib.plan({
        action: Actions.LocalPeerCreate,
        data: { ...PEER_B, peerToken: undefined },
      })
      expect(plan.success).toBe(false)
    })

    it('LocalPeerCreate fails for duplicate peer', () => {
      const rib = createRib()
      planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })

      const plan = rib.plan({ action: Actions.LocalPeerCreate, data: PEER_B })
      expect(plan.success).toBe(false)
    })

    it('LocalPeerUpdate modifies existing peer', () => {
      const rib = createRib()
      planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })

      planCommit(rib, {
        action: Actions.LocalPeerUpdate,
        data: { ...PEER_B, endpoint: 'http://node-b:4000' },
      })

      expect(rib.getState().internal.peers[0].endpoint).toBe('http://node-b:4000')
    })

    it('LocalPeerDelete removes peer', () => {
      const rib = createRib()
      planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })
      planCommit(rib, { action: Actions.LocalPeerDelete, data: { name: PEER_B.name } })

      expect(rib.getState().internal.peers).toHaveLength(0)
    })

    it('InternalProtocolOpen sets connectionStatus to connected', () => {
      const rib = createRib()
      planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })
      planCommit(rib, { action: Actions.InternalProtocolOpen, data: { peerInfo: PEER_B } })

      expect(rib.getState().internal.peers[0].connectionStatus).toBe('connected')
    })

    it('InternalProtocolOpen fails for unknown peer', () => {
      const rib = createRib()
      const plan = rib.plan({
        action: Actions.InternalProtocolOpen,
        data: { peerInfo: PEER_B },
      })
      expect(plan.success).toBe(false)
    })

    it('InternalProtocolConnected sets connectionStatus to connected', () => {
      const rib = createRib()
      planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })
      planCommit(rib, { action: Actions.InternalProtocolConnected, data: { peerInfo: PEER_B } })

      expect(rib.getState().internal.peers[0].connectionStatus).toBe('connected')
    })

    it('InternalProtocolClose removes peer and its routes', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      // Receive a route from peer B
      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })
      expect(rib.getState().internal.routes).toHaveLength(1)

      planCommit(rib, {
        action: Actions.InternalProtocolClose,
        data: { peerInfo: PEER_B, code: 1000 },
      })

      expect(rib.getState().internal.peers).toHaveLength(0)
      expect(rib.getState().internal.routes).toHaveLength(0)
    })

    it('LocalRouteCreate adds route', () => {
      const rib = createRib()
      planCommit(rib, {
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })

      expect(rib.getState().local.routes).toHaveLength(1)
    })

    it('LocalRouteCreate fails for duplicate route', () => {
      const rib = createRib()
      planCommit(rib, {
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })

      const plan = rib.plan({
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })
      expect(plan.success).toBe(false)
    })

    it('LocalRouteDelete removes route', () => {
      const rib = createRib()
      planCommit(rib, {
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })
      planCommit(rib, {
        action: Actions.LocalRouteDelete,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })

      expect(rib.getState().local.routes).toHaveLength(0)
    })

    it('InternalProtocolUpdate adds internal route', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })

      const routes = rib.getState().internal.routes
      expect(routes).toHaveLength(1)
      expect(routes[0].name).toBe('svc-b')
      expect(routes[0].peerName).toBe(PEER_B.name)
      expect(routes[0].nodePath).toEqual([PEER_B.name])
    })

    it('InternalProtocolUpdate upserts existing route from same peer', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })

      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:9090' },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })

      const routes = rib.getState().internal.routes
      expect(routes).toHaveLength(1)
      expect(routes[0].endpoint).toBe('http://b:9090')
    })

    it('InternalProtocolUpdate removes route', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })

      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'remove',
                route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
              },
            ],
          },
        },
      })

      expect(rib.getState().internal.routes).toHaveLength(0)
    })
  })

  describe('loop prevention', () => {
    it('drops updates containing this node in nodePath', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-loop', protocol: 'http' as const, endpoint: 'http://x:8080' },
                nodePath: [PEER_B.name, NODE.name], // contains this node
              },
            ],
          },
        },
      })

      expect(rib.getState().internal.routes).toHaveLength(0)
    })

    it('accepts updates not containing this node in nodePath', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-ok', protocol: 'http' as const, endpoint: 'http://x:8080' },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })

      expect(rib.getState().internal.routes).toHaveLength(1)
    })
  })

  describe('propagation computation', () => {
    it('LocalPeerCreate produces open propagation', () => {
      const rib = createRib()
      const plan = rib.plan({ action: Actions.LocalPeerCreate, data: PEER_B })
      expect(plan.success).toBe(true)

      const p = plan as Plan
      expect(p.propagations).toHaveLength(1)
      expect(p.propagations[0].type).toBe('open')
      expect(p.propagations[0].peer.name).toBe(PEER_B.name)
    })

    it('LocalRouteCreate broadcasts to connected peers only', () => {
      const rib = createRib()
      // Add two peers: B connected, C just created (initializing)
      connectPeer(rib, PEER_B)
      planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_C })

      const plan = rib.plan({
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })

      const p = plan as Plan
      // Only B is connected, C is initializing
      expect(p.propagations).toHaveLength(1)
      expect(p.propagations[0].peer.name).toBe(PEER_B.name)
      expect(p.propagations[0].type).toBe('update')
    })

    it('LocalRouteDelete sends remove to connected peers', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)
      planCommit(rib, {
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })

      const plan = rib.plan({
        action: Actions.LocalRouteDelete,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })

      const p = plan as Plan
      expect(p.propagations).toHaveLength(1)
      expect(p.propagations[0].type).toBe('update')
    })

    it('LocalPeerDelete produces close + withdrawal propagations', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)
      connectPeer(rib, PEER_C)

      // Receive a route from B
      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })

      const plan = rib.plan({
        action: Actions.LocalPeerDelete,
        data: { name: PEER_B.name },
      })

      const p = plan as Plan
      // close to B + withdrawal update to C
      const closeProps = p.propagations.filter((p) => p.type === 'close')
      const updateProps = p.propagations.filter((p) => p.type === 'update')
      expect(closeProps).toHaveLength(1)
      expect(closeProps[0].peer.name).toBe(PEER_B.name)
      expect(updateProps).toHaveLength(1)
      expect(updateProps[0].peer.name).toBe(PEER_C.name)
    })

    it('InternalProtocolUpdate excludes source peer from re-advertisement', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)
      connectPeer(rib, PEER_C)

      const plan = rib.plan({
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })

      const p = plan as Plan
      // Should only propagate to C, not back to B
      expect(p.propagations).toHaveLength(1)
      expect(p.propagations[0].peer.name).toBe(PEER_C.name)
    })

    it('InternalProtocolUpdate filters out loops in re-advertisement', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)
      connectPeer(rib, PEER_C)

      // B sends a route with C already in the nodePath
      const plan = rib.plan({
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-loop', protocol: 'http' as const, endpoint: 'http://x:8080' },
                nodePath: [PEER_B.name, PEER_C.name], // C is already in path
              },
            ],
          },
        },
      })

      const p = plan as Plan
      // Should NOT propagate to C (C is in nodePath) or back to B (source peer)
      expect(p.propagations).toHaveLength(0)
    })

    it('InternalProtocolUpdate prepends this node to nodePath', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)
      connectPeer(rib, PEER_C)

      const plan = rib.plan({
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })

      const p = plan as Plan
      expect(p.propagations).toHaveLength(1)
      const update = (
        p.propagations[0] as { type: 'update'; update: { updates: Array<{ nodePath?: string[] }> } }
      ).update
      expect(update.updates[0].nodePath).toEqual([NODE.name, PEER_B.name])
    })

    it('InternalProtocolClose propagates withdrawals to remaining peers', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)
      connectPeer(rib, PEER_C)

      // Receive a route from B
      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })

      const plan = rib.plan({
        action: Actions.InternalProtocolClose,
        data: { peerInfo: PEER_B, code: 1000 },
      })

      const p = plan as Plan
      // Should send withdrawal to C
      expect(p.propagations).toHaveLength(1)
      expect(p.propagations[0].type).toBe('update')
      expect(p.propagations[0].peer.name).toBe(PEER_C.name)
    })
  })

  describe('full sync on InternalProtocolOpen', () => {
    it('produces full table sync with local and internal routes', () => {
      const rib = createRib()

      // Add a local route
      planCommit(rib, {
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })

      // Connect peer B and receive a route from B
      connectPeer(rib, PEER_B)
      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })

      // Now connect peer C
      planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_C })

      const plan = rib.plan({
        action: Actions.InternalProtocolOpen,
        data: { peerInfo: PEER_C },
      })

      const p = plan as Plan
      expect(p.propagations).toHaveLength(1)
      expect(p.propagations[0].type).toBe('update')

      const update = (
        p.propagations[0] as {
          type: 'update'
          update: {
            updates: Array<{ action: string; route: { name: string }; nodePath: string[] }>
          }
        }
      ).update

      // Should contain both local route (svc-a) and internal route (svc-b)
      const routeNames = update.updates.map((u) => u.route.name)
      expect(routeNames).toContain('svc-a')
      expect(routeNames).toContain('svc-b')

      // Local route should have this node in path
      const svcA = update.updates.find((u) => u.route.name === 'svc-a')!
      expect(svcA.nodePath).toEqual([NODE.name])

      // Internal route should have this node prepended to original path
      const svcB = update.updates.find((u) => u.route.name === 'svc-b')!
      expect(svcB.nodePath).toEqual([NODE.name, PEER_B.name])
    })

    it('excludes routes with target peer in nodePath (split horizon)', () => {
      const rib = createRib()

      connectPeer(rib, PEER_B)
      connectPeer(rib, PEER_C)

      // Receive a route from C
      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_C,
          update: {
            updates: [
              {
                action: 'add',
                route: { name: 'svc-c', protocol: 'http' as const, endpoint: 'http://c:8080' },
                nodePath: [PEER_C.name],
              },
            ],
          },
        },
      })

      // Simulate re-open from C — full sync should NOT include svc-c back to C
      const plan = rib.plan({
        action: Actions.InternalProtocolOpen,
        data: { peerInfo: PEER_C },
      })

      const p = plan as Plan
      if (p.propagations.length > 0) {
        const update = (
          p.propagations[0] as {
            type: 'update'
            update: { updates: Array<{ route: { name: string } }> }
          }
        ).update
        const routeNames = update.updates.map((u) => u.route.name)
        expect(routeNames).not.toContain('svc-c')
      }
    })
  })
})
