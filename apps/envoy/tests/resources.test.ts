import { describe, it, expect } from 'bun:test'
import {
  buildIngressListener,
  buildEgressListener,
  buildLocalCluster,
  buildRemoteCluster,
  buildXdsSnapshot,
} from '../src/xds/resources.js'

// ---------------------------------------------------------------------------
// buildIngressListener
// ---------------------------------------------------------------------------

describe('buildIngressListener', () => {
  it('creates a listener named "ingress_<channelName>"', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
    })
    expect(listener.name).toBe('ingress_books-api')
  })

  it('binds to the given address and port', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
    })
    const addr = listener.address.socket_address
    expect(addr.address).toBe('0.0.0.0')
    expect(addr.port_value).toBe(8001)
  })

  it('routes to the "local_<channelName>" cluster', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
    })
    const hcm = listener.filter_chains[0].filters[0].typed_config
    const route = hcm.route_config.virtual_hosts[0].routes[0].route
    expect(route.cluster).toBe('local_books-api')
  })

  it('sets stat_prefix to "ingress_<channelName>"', () => {
    const listener = buildIngressListener({
      channelName: 'movies-api',
      port: 9001,
      bindAddress: '0.0.0.0',
    })
    const hcm = listener.filter_chains[0].filters[0].typed_config
    expect(hcm.stat_prefix).toBe('ingress_movies-api')
  })

  it('uses http_connection_manager filter', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
    })
    const filter = listener.filter_chains[0].filters[0]
    expect(filter.name).toBe('envoy.filters.network.http_connection_manager')
  })
})

// ---------------------------------------------------------------------------
// buildEgressListener
// ---------------------------------------------------------------------------

describe('buildEgressListener', () => {
  it('creates a listener named "egress_<channelName>_via_<peerName>"', () => {
    const listener = buildEgressListener({
      channelName: 'books-api',
      peerName: 'node-a',
      port: 10001,
    })
    expect(listener.name).toBe('egress_books-api_via_node-a')
  })

  it('binds to 127.0.0.1 (localhost only)', () => {
    const listener = buildEgressListener({
      channelName: 'books-api',
      peerName: 'node-a',
      port: 10001,
    })
    const addr = listener.address.socket_address
    expect(addr.address).toBe('127.0.0.1')
    expect(addr.port_value).toBe(10001)
  })

  it('routes to the "remote_<channelName>_via_<peerName>" cluster', () => {
    const listener = buildEgressListener({
      channelName: 'books-api',
      peerName: 'node-a',
      port: 10001,
    })
    const hcm = listener.filter_chains[0].filters[0].typed_config
    const route = hcm.route_config.virtual_hosts[0].routes[0].route
    expect(route.cluster).toBe('remote_books-api_via_node-a')
  })

  it('sets stat_prefix to "egress_<channelName>_via_<peerName>"', () => {
    const listener = buildEgressListener({
      channelName: 'books-api',
      peerName: 'node-a',
      port: 10001,
    })
    const hcm = listener.filter_chains[0].filters[0].typed_config
    expect(hcm.stat_prefix).toBe('egress_books-api_via_node-a')
  })
})

// ---------------------------------------------------------------------------
// buildLocalCluster
// ---------------------------------------------------------------------------

describe('buildLocalCluster', () => {
  it('creates a cluster named "local_<channelName>"', () => {
    const cluster = buildLocalCluster({
      channelName: 'books-api',
      address: '127.0.0.1',
      port: 5001,
    })
    expect(cluster.name).toBe('local_books-api')
  })

  it('uses STATIC type', () => {
    const cluster = buildLocalCluster({
      channelName: 'books-api',
      address: '127.0.0.1',
      port: 5001,
    })
    expect(cluster.type).toBe('STATIC')
  })

  it('has a 5s connect timeout', () => {
    const cluster = buildLocalCluster({
      channelName: 'books-api',
      address: '127.0.0.1',
      port: 5001,
    })
    expect(cluster.connect_timeout).toBe('5s')
  })

  it('uses ROUND_ROBIN lb policy', () => {
    const cluster = buildLocalCluster({
      channelName: 'books-api',
      address: '127.0.0.1',
      port: 5001,
    })
    expect(cluster.lb_policy).toBe('ROUND_ROBIN')
  })

  it('sets the endpoint address and port', () => {
    const cluster = buildLocalCluster({
      channelName: 'books-api',
      address: '127.0.0.1',
      port: 5001,
    })
    const ep = cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address
    expect(ep.address).toBe('127.0.0.1')
    expect(ep.port_value).toBe(5001)
  })

  it('sets cluster_name in load_assignment', () => {
    const cluster = buildLocalCluster({
      channelName: 'books-api',
      address: '127.0.0.1',
      port: 5001,
    })
    expect(cluster.load_assignment.cluster_name).toBe('local_books-api')
  })
})

// ---------------------------------------------------------------------------
// buildRemoteCluster
// ---------------------------------------------------------------------------

describe('buildRemoteCluster', () => {
  it('creates a cluster named "remote_<channelName>_via_<peerName>"', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-a',
      peerAddress: 'node-a.example.local.io',
      peerPort: 8001,
    })
    expect(cluster.name).toBe('remote_books-api_via_node-a')
  })

  it('uses STRICT_DNS type for hostnames', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-a',
      peerAddress: 'node-a.example.local.io',
      peerPort: 8001,
    })
    expect(cluster.type).toBe('STRICT_DNS')
  })

  it('uses STATIC type for IP addresses', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-a',
      peerAddress: '10.0.0.5',
      peerPort: 8001,
    })
    expect(cluster.type).toBe('STATIC')
  })

  it('recognizes IPv6 addresses as STATIC', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-a',
      peerAddress: '::1',
      peerPort: 8001,
    })
    expect(cluster.type).toBe('STATIC')
  })

  it('sets the peer address and port in the endpoint', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-a',
      peerAddress: 'node-a.example.local.io',
      peerPort: 8001,
    })
    const ep = cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address
    expect(ep.address).toBe('node-a.example.local.io')
    expect(ep.port_value).toBe(8001)
  })

  it('has a 5s connect timeout', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-a',
      peerAddress: 'node-a.example.local.io',
      peerPort: 8001,
    })
    expect(cluster.connect_timeout).toBe('5s')
  })
})

// ---------------------------------------------------------------------------
// buildXdsSnapshot
// ---------------------------------------------------------------------------

describe('buildXdsSnapshot', () => {
  it('returns a snapshot with a version string', () => {
    const snapshot = buildXdsSnapshot({
      local: [],
      internal: [],
      portAllocations: {},
      bindAddress: '0.0.0.0',
    })
    expect(snapshot.version).toBeDefined()
    expect(typeof snapshot.version).toBe('string')
  })

  it('generates monotonically increasing versions', () => {
    const s1 = buildXdsSnapshot({
      local: [],
      internal: [],
      portAllocations: {},
      bindAddress: '0.0.0.0',
    })
    const s2 = buildXdsSnapshot({
      local: [],
      internal: [],
      portAllocations: {},
      bindAddress: '0.0.0.0',
    })
    expect(Number(s2.version)).toBeGreaterThan(Number(s1.version))
  })

  it('returns empty listeners and clusters for empty routes', () => {
    const snapshot = buildXdsSnapshot({
      local: [],
      internal: [],
      portAllocations: {},
      bindAddress: '0.0.0.0',
    })
    expect(snapshot.listeners).toEqual([])
    expect(snapshot.clusters).toEqual([])
  })

  it('creates ingress listener + local cluster for local routes', () => {
    const snapshot = buildXdsSnapshot({
      local: [
        {
          name: 'books-api',
          protocol: 'http',
          endpoint: 'http://localhost:5001',
          envoyPort: 8001,
        },
      ],
      internal: [],
      portAllocations: { 'books-api': 8001 },
      bindAddress: '0.0.0.0',
    })

    expect(snapshot.listeners).toHaveLength(1)
    expect(snapshot.listeners[0].name).toBe('ingress_books-api')

    expect(snapshot.clusters).toHaveLength(1)
    expect(snapshot.clusters[0].name).toBe('local_books-api')
  })

  it('creates egress listener + remote cluster for internal routes', () => {
    const snapshot = buildXdsSnapshot({
      local: [],
      internal: [
        {
          name: 'movies-api',
          protocol: 'http:graphql',
          endpoint: 'http://peer-node:8081/graphql',
          envoyPort: 8002,
          peer: { name: 'node-a', envoyAddress: 'node-a.example.local.io' },
          peerName: 'node-a',
          nodePath: ['local-node', 'node-a'],
        },
      ],
      portAllocations: { 'egress_movies-api_via_node-a': 10001 },
      bindAddress: '0.0.0.0',
    })

    expect(snapshot.listeners).toHaveLength(1)
    expect(snapshot.listeners[0].name).toBe('egress_movies-api_via_node-a')

    expect(snapshot.clusters).toHaveLength(1)
    expect(snapshot.clusters[0].name).toBe('remote_movies-api_via_node-a')
  })

  it('creates both ingress and egress resources for mixed routes', () => {
    const snapshot = buildXdsSnapshot({
      local: [
        {
          name: 'books-api',
          protocol: 'http',
          endpoint: 'http://localhost:5001',
          envoyPort: 8001,
        },
      ],
      internal: [
        {
          name: 'movies-api',
          protocol: 'http:graphql',
          endpoint: 'http://peer-node:8081/graphql',
          envoyPort: 8002,
          peer: { name: 'node-a', envoyAddress: '10.0.0.5' },
          peerName: 'node-a',
          nodePath: ['local-node', 'node-a'],
        },
      ],
      portAllocations: {
        'books-api': 8001,
        'egress_movies-api_via_node-a': 10001,
      },
      bindAddress: '0.0.0.0',
    })

    expect(snapshot.listeners).toHaveLength(2)
    expect(snapshot.clusters).toHaveLength(2)

    const listenerNames = snapshot.listeners.map((l) => l.name).sort()
    expect(listenerNames).toEqual(['egress_movies-api_via_node-a', 'ingress_books-api'])

    const clusterNames = snapshot.clusters.map((c) => c.name).sort()
    expect(clusterNames).toEqual(['local_books-api', 'remote_movies-api_via_node-a'])
  })

  it('uses portAllocations for ingress listener port', () => {
    const snapshot = buildXdsSnapshot({
      local: [
        {
          name: 'books-api',
          protocol: 'http',
          endpoint: 'http://localhost:5001',
          envoyPort: 8001,
        },
      ],
      internal: [],
      portAllocations: { 'books-api': 8001 },
      bindAddress: '0.0.0.0',
    })

    const addr = snapshot.listeners[0].address.socket_address
    expect(addr.port_value).toBe(8001)
  })

  it('uses portAllocations for egress listener port', () => {
    const snapshot = buildXdsSnapshot({
      local: [],
      internal: [
        {
          name: 'movies-api',
          protocol: 'http',
          endpoint: 'http://peer-node:8081',
          envoyPort: 8002,
          peer: { name: 'node-a', envoyAddress: '10.0.0.5' },
          peerName: 'node-a',
          nodePath: ['local', 'node-a'],
        },
      ],
      portAllocations: { 'egress_movies-api_via_node-a': 10001 },
      bindAddress: '0.0.0.0',
    })

    const addr = snapshot.listeners[0].address.socket_address
    expect(addr.address).toBe('127.0.0.1')
    expect(addr.port_value).toBe(10001)
  })

  it('uses envoyPort from internal route as the remote cluster port', () => {
    const snapshot = buildXdsSnapshot({
      local: [],
      internal: [
        {
          name: 'movies-api',
          protocol: 'http',
          endpoint: 'http://peer-node:8081',
          envoyPort: 8002,
          peer: { name: 'node-a', envoyAddress: '10.0.0.5' },
          peerName: 'node-a',
          nodePath: ['local', 'node-a'],
        },
      ],
      portAllocations: { 'egress_movies-api_via_node-a': 10001 },
      bindAddress: '0.0.0.0',
    })

    const ep =
      snapshot.clusters[0].load_assignment.endpoints[0].lb_endpoints[0].endpoint.address
        .socket_address
    expect(ep.address).toBe('10.0.0.5')
    expect(ep.port_value).toBe(8002)
  })

  it('skips local routes without an endpoint', () => {
    const snapshot = buildXdsSnapshot({
      local: [
        {
          name: 'no-endpoint',
          protocol: 'http',
        },
      ],
      internal: [],
      portAllocations: { 'no-endpoint': 8001 },
      bindAddress: '0.0.0.0',
    })

    expect(snapshot.listeners).toHaveLength(0)
    expect(snapshot.clusters).toHaveLength(0)
  })

  it('skips internal routes without envoyPort', () => {
    const snapshot = buildXdsSnapshot({
      local: [],
      internal: [
        {
          name: 'movies-api',
          protocol: 'http',
          endpoint: 'http://peer-node:8081',
          // no envoyPort
          peer: { name: 'node-a', envoyAddress: '10.0.0.5' },
          peerName: 'node-a',
          nodePath: ['local', 'node-a'],
        },
      ],
      portAllocations: { 'egress_movies-api_via_node-a': 10001 },
      bindAddress: '0.0.0.0',
    })

    expect(snapshot.listeners).toHaveLength(0)
    expect(snapshot.clusters).toHaveLength(0)
  })

  it('parses endpoint URL to extract address and port for local clusters', () => {
    const snapshot = buildXdsSnapshot({
      local: [
        {
          name: 'books-api',
          protocol: 'http',
          endpoint: 'http://localhost:5001/graphql',
          envoyPort: 8001,
        },
      ],
      internal: [],
      portAllocations: { 'books-api': 8001 },
      bindAddress: '0.0.0.0',
    })

    const ep =
      snapshot.clusters[0].load_assignment.endpoints[0].lb_endpoints[0].endpoint.address
        .socket_address
    expect(ep.address).toBe('localhost')
    expect(ep.port_value).toBe(5001)
  })
})
