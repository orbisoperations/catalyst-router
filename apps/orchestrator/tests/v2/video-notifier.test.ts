import { describe, it, expect } from 'vitest'
import {
  buildStreamCatalog,
  hasMediaRouteChanges,
  StreamCatalogSchema,
} from '../../src/v2/video-notifier.js'
import type { RouteTable, InternalRoute, RouteChange, PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const nodeId = 'node-a'

const peerBInfo: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['example.local'],
}

function emptyRouteTable(): RouteTable {
  return {
    local: { routes: [] },
    internal: { peers: [], routes: [] },
  }
}

function makeInternalRoute(
  overrides: Partial<InternalRoute> & { name: string; protocol: string }
): InternalRoute {
  return {
    endpoint: undefined,
    peer: peerBInfo,
    nodePath: ['node-b'],
    originNode: 'node-b',
    isStale: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildStreamCatalog', () => {
  it('maps local media routes to source: local', () => {
    const state: RouteTable = {
      ...emptyRouteTable(),
      local: {
        routes: [
          { name: 'cam-front', protocol: 'media', endpoint: 'rtsp://localhost:8554/cam-front' },
        ],
      },
    }

    const catalog = buildStreamCatalog(nodeId, state)

    expect(catalog.streams).toHaveLength(1)
    expect(catalog.streams[0]).toEqual({
      name: 'cam-front',
      protocol: 'media',
      endpoint: 'rtsp://localhost:8554/cam-front',
      source: 'local',
      sourceNode: 'node-a',
    })
  })

  it('maps internal media routes to source: remote', () => {
    const state: RouteTable = {
      ...emptyRouteTable(),
      internal: {
        peers: [],
        routes: [
          makeInternalRoute({
            name: 'cam-rear',
            protocol: 'media',
            endpoint: 'rtsp://node-b:8554/cam-rear',
            originNode: 'node-b',
            nodePath: ['node-b'],
          }),
        ],
      },
    }

    const catalog = buildStreamCatalog(nodeId, state)

    expect(catalog.streams).toHaveLength(1)
    expect(catalog.streams[0]).toEqual({
      name: 'cam-rear',
      protocol: 'media',
      endpoint: 'rtsp://node-b:8554/cam-rear',
      source: 'remote',
      sourceNode: 'node-b',
      nodePath: ['node-b'],
    })
  })

  it('excludes non-media routes', () => {
    const state: RouteTable = {
      local: {
        routes: [
          { name: 'api', protocol: 'http', endpoint: 'http://localhost:8080' },
          { name: 'gql', protocol: 'http:graphql', endpoint: 'http://localhost:8081' },
        ],
      },
      internal: {
        peers: [],
        routes: [makeInternalRoute({ name: 'remote-api', protocol: 'http' })],
      },
    }

    const catalog = buildStreamCatalog(nodeId, state)

    expect(catalog.streams).toHaveLength(0)
  })

  it('excludes stale internal routes', () => {
    const state: RouteTable = {
      ...emptyRouteTable(),
      internal: {
        peers: [],
        routes: [
          makeInternalRoute({
            name: 'cam-stale',
            protocol: 'media',
            isStale: true,
          }),
        ],
      },
    }

    const catalog = buildStreamCatalog(nodeId, state)

    expect(catalog.streams).toHaveLength(0)
  })

  it('returns { streams: [] } when no media routes exist', () => {
    const catalog = buildStreamCatalog(nodeId, emptyRouteTable())

    expect(catalog).toEqual({ streams: [] })
  })

  it('includes both local and remote media routes', () => {
    const state: RouteTable = {
      local: {
        routes: [
          { name: 'cam-front', protocol: 'media' },
          { name: 'api', protocol: 'http' },
        ],
      },
      internal: {
        peers: [],
        routes: [
          makeInternalRoute({ name: 'cam-rear', protocol: 'media' }),
          makeInternalRoute({ name: 'remote-api', protocol: 'http' }),
        ],
      },
    }

    const catalog = buildStreamCatalog(nodeId, state)

    expect(catalog.streams).toHaveLength(2)
    expect(catalog.streams.map((s) => s.name).sort()).toEqual(['cam-front', 'cam-rear'])
  })

  it('validates output against StreamCatalogSchema', () => {
    const state: RouteTable = {
      local: {
        routes: [{ name: 'cam-front', protocol: 'media', endpoint: 'rtsp://localhost:8554/cam' }],
      },
      internal: {
        peers: [],
        routes: [
          makeInternalRoute({
            name: 'cam-rear',
            protocol: 'media',
            originNode: 'node-b',
            nodePath: ['node-b'],
          }),
        ],
      },
    }

    const catalog = buildStreamCatalog(nodeId, state)
    const result = StreamCatalogSchema.safeParse(catalog)

    expect(result.success).toBe(true)
  })
})

describe('hasMediaRouteChanges', () => {
  it('returns true for media route changes', () => {
    const changes: RouteChange[] = [
      { type: 'added', route: { name: 'cam-front', protocol: 'media' } },
    ]

    expect(hasMediaRouteChanges(changes)).toBe(true)
  })

  it('returns false for HTTP-only changes', () => {
    const changes: RouteChange[] = [
      { type: 'added', route: { name: 'api', protocol: 'http' } },
      { type: 'removed', route: { name: 'gql', protocol: 'http:graphql' } },
    ]

    expect(hasMediaRouteChanges(changes)).toBe(false)
  })

  it('returns false for empty changes', () => {
    expect(hasMediaRouteChanges([])).toBe(false)
  })

  it('returns true when mixed changes include at least one media route', () => {
    const changes: RouteChange[] = [
      { type: 'added', route: { name: 'api', protocol: 'http' } },
      { type: 'added', route: { name: 'cam-front', protocol: 'media' } },
    ]

    expect(hasMediaRouteChanges(changes)).toBe(true)
  })
})
