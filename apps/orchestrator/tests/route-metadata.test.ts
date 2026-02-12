import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
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

function createRib() {
  return new RoutingInformationBase(CONFIG)
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

/** Helper: inject an internal route from a peer */
function injectRoute(
  rib: RoutingInformationBase,
  peer: PeerInfo,
  route: { name: string; protocol: 'http'; endpoint: string },
  nodePath: string[]
) {
  planCommit(rib, {
    action: Actions.InternalProtocolUpdate,
    data: {
      peerInfo: peer,
      update: {
        updates: [{ action: 'add', route, nodePath }],
      },
    },
  })
}

describe('Route Metadata', () => {
  it('single route from one peer has reason "only candidate"', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
    ])

    const metadata = rib.getRouteMetadata()
    expect(metadata.size).toBe(1)

    const entry = metadata.get('svc-x')!
    expect(entry).toBeDefined()
    expect(entry.bestPath.name).toBe('svc-x')
    expect(entry.bestPath.peerName).toBe(PEER_B.name)
    expect(entry.alternatives).toHaveLength(0)
    expect(entry.selectionReason).toBe('only candidate')
  })

  it('same route from two peers selects shorter nodePath as best', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // B advertises svc-x with a 1-hop path
    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
    ])

    // C advertises svc-x with a 2-hop path (via some other node)
    injectRoute(rib, PEER_C, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_C.name,
      'node-d.somebiz.local.io',
    ])

    const metadata = rib.getRouteMetadata()
    const entry = metadata.get('svc-x')!
    expect(entry).toBeDefined()

    // B's path is shorter (1 hop vs 2 hops)
    expect(entry.bestPath.peerName).toBe(PEER_B.name)
    expect(entry.bestPath.nodePath).toEqual([PEER_B.name])
    expect(entry.selectionReason).toBe('shortest nodePath')
    expect(entry.alternatives).toHaveLength(1)
    expect(entry.alternatives[0].peerName).toBe(PEER_C.name)
  })

  it('withdrawal removes route from metadata', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // Both peers advertise svc-x
    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
    ])
    injectRoute(rib, PEER_C, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_C.name,
      'node-d.somebiz.local.io',
    ])

    expect(rib.getRouteMetadata().get('svc-x')!.alternatives).toHaveLength(1)

    // B withdraws svc-x
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'remove',
              route: { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' },
            },
          ],
        },
      },
    })

    const metadata = rib.getRouteMetadata()
    const entry = metadata.get('svc-x')!
    expect(entry).toBeDefined()
    // C's route is now the only candidate
    expect(entry.bestPath.peerName).toBe(PEER_C.name)
    expect(entry.alternatives).toHaveLength(0)
    expect(entry.selectionReason).toBe('only candidate')
  })

  it('peer disconnect removes routes from metadata', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
    ])
    expect(rib.getRouteMetadata().size).toBe(1)

    // Close connection to B
    planCommit(rib, {
      action: Actions.InternalProtocolClose,
      data: { peerInfo: PEER_B, code: 1000 },
    })

    expect(rib.getRouteMetadata().size).toBe(0)
  })

  it('metadata is accessible via rib.getRouteMetadata()', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // No routes yet — metadata should be empty
    expect(rib.getRouteMetadata().size).toBe(0)

    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
    ])

    const metadata = rib.getRouteMetadata()
    expect(metadata).toBeInstanceOf(Map)
    expect(metadata.size).toBe(1)
    expect(metadata.has('svc-x')).toBe(true)
  })

  it('metadata only tracks internal routes, not local routes', () => {
    const rib = createRib()

    planCommit(rib, {
      action: Actions.LocalRouteCreate,
      data: { name: 'local-svc', protocol: 'http' as const, endpoint: 'http://local:8080' },
    })

    // Local routes are not in route metadata (metadata tracks best path selection
    // across internal routes from different peers)
    expect(rib.getRouteMetadata().size).toBe(0)
  })

  it('withdrawal of all routes for a prefix removes it from metadata', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
    ])
    expect(rib.getRouteMetadata().size).toBe(1)

    // Withdraw the route
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'remove',
              route: { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' },
            },
          ],
        },
      },
    })

    expect(rib.getRouteMetadata().size).toBe(0)
  })

  it('multiple distinct routes produce separate metadata entries', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
    ])
    injectRoute(rib, PEER_B, { name: 'svc-y', protocol: 'http', endpoint: 'http://y:8080' }, [
      PEER_B.name,
    ])

    const metadata = rib.getRouteMetadata()
    expect(metadata.size).toBe(2)
    expect(metadata.has('svc-x')).toBe(true)
    expect(metadata.has('svc-y')).toBe(true)
    expect(metadata.get('svc-x')!.selectionReason).toBe('only candidate')
    expect(metadata.get('svc-y')!.selectionReason).toBe('only candidate')
  })
})
