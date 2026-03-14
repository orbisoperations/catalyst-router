import { describe, it, expect } from 'vitest'
import {
  toPublicPeer,
  toPublicInternalRoute,
  toDataChannel,
  toPublicRouteTable,
  internalRouteCount,
} from '../../src/v2/views.js'
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
  const routeA = makeInternalRoute()
  const routeB = makeInternalRoute({
    name: 'route-b',
    peer: { name: 'peer-2', domains: ['example.com'] },
    nodePath: ['peer-2'],
    originNode: 'peer-2',
    isStale: true,
  })
  return {
    local: {
      routes: new Map([
        [
          'local-route',
          { name: 'local-route', protocol: 'http' as const, endpoint: 'http://local:8080' },
        ],
      ]),
    },
    internal: {
      peers: new Map([
        ['peer-1', makePeerRecord({ peerToken: 'secret-1' })],
        ['peer-2', makePeerRecord({ name: 'peer-2', peerToken: 'secret-2' })],
      ]),
      routes: new Map([
        ['peer-1', new Map([[`${routeA.name}:${routeA.originNode}`, routeA]])],
        ['peer-2', new Map([[`${routeB.name}:${routeB.originNode}`, routeB]])],
      ]),
    },
  }
}

describe('toPublicPeer', () => {
  it('strips peerToken', () => {
    const peer = makePeerRecord({ peerToken: 'secret' })
    const pub = toPublicPeer(peer)
    expect(pub).not.toHaveProperty('peerToken')
    expect(pub.name).toBe('peer-1')
  })

  it('strips holdTime, lastSent, lastReceived', () => {
    const pub = toPublicPeer(makePeerRecord())
    expect(pub).not.toHaveProperty('holdTime')
    expect(pub).not.toHaveProperty('lastSent')
    expect(pub).not.toHaveProperty('lastReceived')
  })

  it('preserves name, domains, endpoint, connectionStatus', () => {
    const pub = toPublicPeer(makePeerRecord({ endpoint: 'ws://peer:4000' }))
    expect(pub.name).toBe('peer-1')
    expect(pub.domains).toEqual(['example.com'])
    expect(pub.endpoint).toBe('ws://peer:4000')
    expect(pub.connectionStatus).toBe('connected')
  })
})

describe('toPublicInternalRoute', () => {
  it('strips peerToken from peer', () => {
    const pub = toPublicInternalRoute(makeInternalRoute())
    expect(pub.peer).not.toHaveProperty('peerToken')
    expect(pub.peer.name).toBe('peer-1')
  })

  it('strips isStale', () => {
    const pub = toPublicInternalRoute(makeInternalRoute({ isStale: true }))
    expect(pub).not.toHaveProperty('isStale')
  })
})

describe('toDataChannel', () => {
  it('returns only DataChannelDefinition fields', () => {
    const route = makeInternalRoute({ region: 'us-east', tags: ['a'], envoyPort: 10000 })
    const dc = toDataChannel(route)
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

describe('toPublicRouteTable', () => {
  it('strips all credentials', () => {
    const pub = toPublicRouteTable(makeRouteTable())

    for (const peer of pub.peers) {
      expect(peer).not.toHaveProperty('peerToken')
      expect(peer).not.toHaveProperty('holdTime')
      expect(peer).not.toHaveProperty('lastSent')
      expect(peer).not.toHaveProperty('lastReceived')
    }

    for (const route of pub.routes.internal) {
      expect(route.peer).not.toHaveProperty('peerToken')
      expect(route).not.toHaveProperty('isStale')
    }

    expect(pub.routes.local).toEqual([...table.local.routes.values()])
  })

  it('preserves data integrity', () => {
    const table = makeRouteTable()
    const pub = toPublicRouteTable(table)
    expect(pub.peers).toHaveLength(2)
    expect(pub.routes.internal).toHaveLength(2)
    expect(pub.routes.local).toHaveLength(1)
    expect(pub.peers[0].name).toBe('peer-1')
    expect(pub.routes.internal[0].name).toBe('route-a')
  })
})

describe('internalRouteCount', () => {
  it('counts routes across all peers', () => {
    const table = makeRouteTable()
    expect(internalRouteCount(table)).toBe(2)
  })

  it('returns 0 for empty table', () => {
    const table: RouteTable = {
      local: { routes: new Map() },
      internal: { peers: new Map(), routes: new Map() },
    }
    expect(internalRouteCount(table)).toBe(0)
  })
})
