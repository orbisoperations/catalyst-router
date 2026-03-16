import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { RouteTableView } from '@catalyst/routing/v2'
import type { RouteTable } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRouteTable(): RouteTable {
  const localRoutes = new Map([
    ['local-svc', { name: 'local-svc', protocol: 'http' as const, endpoint: 'http://local:8080' }],
  ])

  const peers = new Map([
    [
      'peer-1',
      {
        name: 'peer-1',
        endpoint: 'ws://peer-1:4000',
        domains: ['example.local'],
        connectionStatus: 'connected' as const,
        peerToken: 'secret-token-1',
        holdTime: 90_000,
        lastSent: 100,
        lastReceived: 200,
      },
    ],
  ])

  const innerRoutes = new Map([
    [
      'remote-svc|peer-1',
      {
        name: 'remote-svc',
        protocol: 'http' as const,
        endpoint: 'http://remote:8080',
        peer: {
          name: 'peer-1',
          domains: ['example.local'],
          peerToken: 'secret-peer-token',
        },
        nodePath: ['peer-1'],
        originNode: 'peer-1',
        isStale: false,
      },
    ],
  ])

  const internalRoutes = new Map([['peer-1', innerRoutes]])

  return {
    local: { routes: localRoutes },
    internal: { peers, routes: internalRoutes },
  }
}

/**
 * Build a minimal Hono app that mirrors the /api/state endpoint in catalyst-service.ts.
 * This lets us test the endpoint logic without instantiating the full OrchestratorService.
 */
function buildApp(snapshot: RouteTable) {
  const app = new Hono()
  app.get('/api/state', (c) => {
    return c.json(new RouteTableView(snapshot).toPublic())
  })
  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/state', () => {
  it('returns 200 with routes and peers', async () => {
    const app = buildApp(makeRouteTable())
    const res = await app.request('/api/state')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toHaveProperty('routes')
    expect(body).toHaveProperty('peers')
    expect(body.routes).toHaveProperty('local')
    expect(body.routes).toHaveProperty('internal')
  })

  it('returns local routes unchanged', async () => {
    const app = buildApp(makeRouteTable())
    const res = await app.request('/api/state')
    const body = await res.json()

    expect(body.routes.local).toHaveLength(1)
    expect(body.routes.local[0]).toEqual({
      name: 'local-svc',
      protocol: 'http',
      endpoint: 'http://local:8080',
    })
  })

  it('returns internal routes with peer credentials stripped', async () => {
    const app = buildApp(makeRouteTable())
    const res = await app.request('/api/state')
    const body = await res.json()

    expect(body.routes.internal).toHaveLength(1)
    const route = body.routes.internal[0]
    expect(route.peer).not.toHaveProperty('peerToken')
    expect(route).not.toHaveProperty('isStale')
    expect(route.peer.name).toBe('peer-1')
  })

  it('returns peers with no peerToken, holdTime, lastSent, or lastReceived', async () => {
    const app = buildApp(makeRouteTable())
    const res = await app.request('/api/state')
    const body = await res.json()

    expect(body.peers).toHaveLength(1)
    const peer = body.peers[0]
    expect(peer).not.toHaveProperty('peerToken')
    expect(peer).not.toHaveProperty('holdTime')
    expect(peer).not.toHaveProperty('lastSent')
    expect(peer).not.toHaveProperty('lastReceived')
    expect(peer.name).toBe('peer-1')
    expect(peer.connectionStatus).toBe('connected')
  })
})
