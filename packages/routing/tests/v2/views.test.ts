import { describe, it, expect } from 'vitest'
import { PeerView, InternalRouteView, RouteTableView } from '../../src/v2/views.js'
import type { PeerRecord, InternalRoute, RouteTable } from '../../src/v2/index.js'

function makePeerRecord(overrides: Partial<PeerRecord> = {}): PeerRecord {
  return {
    name: 'peer-1',
    domains: ['example.com'],
    connectionStatus: 'connected',
    holdTime: 90_000,
    lastSent: 0,
    lastReceived: 1000,
    ...overrides,
  }
}

function makeInternalRoute(overrides: Partial<InternalRoute> = {}): InternalRoute {
  return {
    name: 'route-a',
    protocol: 'http',
    endpoint: 'http://a:8080',
    peer: { name: 'peer-1', domains: ['example.com'], peerToken: 'secret-token' },
    nodePath: ['peer-1'],
    originNode: 'peer-1',
    ...overrides,
  }
}

function makeRouteTable(): RouteTable {
  return {
    local: {
      routes: [{ name: 'local-route', protocol: 'http' as const, endpoint: 'http://local:8080' }],
    },
    internal: {
      peers: [
        makePeerRecord({ peerToken: 'secret-1' }),
        makePeerRecord({ name: 'peer-2', peerToken: 'secret-2' }),
      ],
      routes: [
        makeInternalRoute(),
        makeInternalRoute({
          name: 'route-b',
          peer: { name: 'peer-2', domains: ['example.com'] },
          nodePath: ['peer-2'],
          originNode: 'peer-2',
          isStale: true,
        }),
      ],
    },
  }
}

describe('PeerView', () => {
  it('strips peerToken from toPublic()', () => {
    const peer = makePeerRecord({ peerToken: 'secret' })
    const view = new PeerView(peer)
    const pub = view.toPublic()
    expect(pub).not.toHaveProperty('peerToken')
    expect(pub.name).toBe('peer-1')
  })

  it('strips holdTime, lastSent, lastReceived from toPublic()', () => {
    const peer = makePeerRecord()
    const pub = new PeerView(peer).toPublic()
    expect(pub).not.toHaveProperty('holdTime')
    expect(pub).not.toHaveProperty('lastSent')
    expect(pub).not.toHaveProperty('lastReceived')
  })

  it('preserves name, domains, endpoint, connectionStatus', () => {
    const peer = makePeerRecord({ endpoint: 'ws://peer:4000' })
    const pub = new PeerView(peer).toPublic()
    expect(pub.name).toBe('peer-1')
    expect(pub.domains).toEqual(['example.com'])
    expect(pub.endpoint).toBe('ws://peer:4000')
    expect(pub.connectionStatus).toBe('connected')
  })
})

describe('InternalRouteView', () => {
  it('strips peerToken from peer in toPublic()', () => {
    const route = makeInternalRoute()
    const pub = new InternalRouteView(route).toPublic()
    expect(pub.peer).not.toHaveProperty('peerToken')
    expect(pub.peer.name).toBe('peer-1')
  })

  it('strips isStale from toPublic()', () => {
    const route = makeInternalRoute({ isStale: true })
    const pub = new InternalRouteView(route).toPublic()
    expect(pub).not.toHaveProperty('isStale')
  })

  it('toDataChannel() returns only DataChannelDefinition fields', () => {
    const route = makeInternalRoute({ region: 'us-east', tags: ['a'], envoyPort: 10000 })
    const dc = new InternalRouteView(route).toDataChannel()
    expect(dc).toEqual({
      name: 'route-a',
      protocol: 'http',
      endpoint: 'http://a:8080',
      region: 'us-east',
      tags: ['a'],
      envoyPort: 10000,
    })
    expect(dc).not.toHaveProperty('peer')
    expect(dc).not.toHaveProperty('nodePath')
    expect(dc).not.toHaveProperty('originNode')
    expect(dc).not.toHaveProperty('isStale')
  })
})

describe('RouteTableView', () => {
  it('toPublic() strips all credentials', () => {
    const table = makeRouteTable()
    const pub = new RouteTableView(table).toPublic()

    // Peers: no peerToken, no holdTime/lastSent/lastReceived
    for (const peer of pub.peers) {
      expect(peer).not.toHaveProperty('peerToken')
      expect(peer).not.toHaveProperty('holdTime')
      expect(peer).not.toHaveProperty('lastSent')
      expect(peer).not.toHaveProperty('lastReceived')
    }

    // Internal routes: no peerToken on peer, no isStale
    for (const route of pub.routes.internal) {
      expect(route.peer).not.toHaveProperty('peerToken')
      expect(route).not.toHaveProperty('isStale')
    }

    // Local routes pass through unchanged
    expect(pub.routes.local).toEqual(table.local.routes)
  })

  it('toPublic() preserves data integrity', () => {
    const table = makeRouteTable()
    const pub = new RouteTableView(table).toPublic()
    expect(pub.peers).toHaveLength(2)
    expect(pub.routes.internal).toHaveLength(2)
    expect(pub.routes.local).toHaveLength(1)
    expect(pub.peers[0].name).toBe('peer-1')
    expect(pub.routes.internal[0].name).toBe('route-a')
  })
})
