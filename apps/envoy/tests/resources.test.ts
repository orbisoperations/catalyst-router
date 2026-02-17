import { describe, it, expect } from 'bun:test'
import {
  buildIngressListener,
  buildEgressListener,
  buildLocalCluster,
  buildRemoteCluster,
  buildXdsSnapshot,
  buildTcpProxyIngressListener,
  buildTcpProxyEgressListener,
  isTcpProxyListener,
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
      version: '1',
    })
    expect(listener.name).toBe('ingress_books-api')
  })

  it('binds to the given address and port', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      version: '1',
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
      version: '1',
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
      version: '1',
    })
    const hcm = listener.filter_chains[0].filters[0].typed_config
    expect(hcm.stat_prefix).toBe('ingress_movies-api')
  })

  it('uses http_connection_manager filter', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      version: '1',
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

  it('defaults bind address to 0.0.0.0', () => {
    const listener = buildEgressListener({
      channelName: 'books-api',
      peerName: 'node-a',
      port: 10001,
    })
    const addr = listener.address.socket_address
    expect(addr.address).toBe('0.0.0.0')
    expect(addr.port_value).toBe(10001)
  })

  it('uses custom bind address when provided', () => {
    const listener = buildEgressListener({
      channelName: 'books-api',
      peerName: 'node-a',
      port: 10001,
      bindAddress: '127.0.0.1',
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

  it('sets dns_lookup_family V4_ONLY for hostname addresses (STRICT_DNS)', () => {
    const cluster = buildLocalCluster({
      channelName: 'books-api',
      address: 'books.internal',
      port: 5001,
    })
    expect(cluster.type).toBe('STRICT_DNS')
    expect(cluster.dns_lookup_family).toBe(1)
  })

  it('does not set dns_lookup_family for IP addresses (STATIC)', () => {
    const cluster = buildLocalCluster({
      channelName: 'books-api',
      address: '127.0.0.1',
      port: 5001,
    })
    expect(cluster.type).toBe('STATIC')
    expect(cluster.dns_lookup_family).toBeUndefined()
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

  it('uses STRICT_DNS for invalid IPv4 with out-of-range octets', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-a',
      peerAddress: '999.999.999.999',
      peerPort: 8001,
    })
    expect(cluster.type).toBe('STRICT_DNS')
  })

  it('uses STRICT_DNS for partially invalid IPv4 octets', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-a',
      peerAddress: '256.0.0.1',
      peerPort: 8001,
    })
    expect(cluster.type).toBe('STRICT_DNS')
  })

  it('uses STATIC for valid boundary IPv4 (255.255.255.255)', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-a',
      peerAddress: '255.255.255.255',
      peerPort: 8001,
    })
    expect(cluster.type).toBe('STATIC')
  })

  it('uses STATIC for valid IPv4 (0.0.0.0)', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-a',
      peerAddress: '0.0.0.0',
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

  it('sets dns_lookup_family V4_ONLY for hostname addresses (STRICT_DNS)', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-a',
      peerAddress: 'node-a.example.local.io',
      peerPort: 8001,
    })
    expect(cluster.type).toBe('STRICT_DNS')
    expect(cluster.dns_lookup_family).toBe(1)
  })

  it('does not set dns_lookup_family for IP addresses (STATIC)', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-a',
      peerAddress: '10.0.0.5',
      peerPort: 8001,
    })
    expect(cluster.type).toBe('STATIC')
    expect(cluster.dns_lookup_family).toBeUndefined()
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
      version: '1',
    })
    expect(snapshot.version).toBeDefined()
    expect(typeof snapshot.version).toBe('string')
  })

  it('uses the caller-provided version string', () => {
    const s1 = buildXdsSnapshot({
      local: [],
      internal: [],
      portAllocations: {},
      bindAddress: '0.0.0.0',
      version: '1',
    })
    const s2 = buildXdsSnapshot({
      local: [],
      internal: [],
      portAllocations: {},
      bindAddress: '0.0.0.0',
      version: '2',
    })
    expect(s1.version).toBe('1')
    expect(s2.version).toBe('2')
  })

  it('returns empty listeners and clusters for empty routes', () => {
    const snapshot = buildXdsSnapshot({
      local: [],
      internal: [],
      portAllocations: {},
      bindAddress: '0.0.0.0',
      version: '1',
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
      version: '1',
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
      version: '1',
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
      version: '1',
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
      version: '1',
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
      version: '1',
    })

    const addr = snapshot.listeners[0].address.socket_address
    expect(addr.address).toBe('0.0.0.0')
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
      version: '1',
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
      version: '1',
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
      version: '1',
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
      version: '1',
    })

    const ep =
      snapshot.clusters[0].load_assignment.endpoints[0].lb_endpoints[0].endpoint.address
        .socket_address
    expect(ep.address).toBe('localhost')
    expect(ep.port_value).toBe(5001)
  })
})

// ---------------------------------------------------------------------------
// Protocol-specific configuration
// ---------------------------------------------------------------------------

describe('protocol-specific listener config', () => {
  it('adds WebSocket upgrade_configs for http:graphql protocol', () => {
    const listener = buildIngressListener({
      channelName: 'gql-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      protocol: 'http:graphql',
    })
    const hcm = listener.filter_chains[0].filters[0].typed_config
    expect(hcm.upgrade_configs).toEqual([{ upgrade_type: 'websocket' }])
  })

  it('adds WebSocket upgrade_configs for http:gql protocol', () => {
    const listener = buildIngressListener({
      channelName: 'gql-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      protocol: 'http:gql',
    })
    const hcm = listener.filter_chains[0].filters[0].typed_config
    expect(hcm.upgrade_configs).toEqual([{ upgrade_type: 'websocket' }])
  })

  it('disables route timeout for http:graphql (long-lived subscriptions)', () => {
    const listener = buildIngressListener({
      channelName: 'gql-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      protocol: 'http:graphql',
    })
    const route =
      listener.filter_chains[0].filters[0].typed_config.route_config.virtual_hosts[0].routes[0]
        .route
    expect(route.timeout).toEqual({ seconds: 0, nanos: 0 })
  })

  it('disables route timeout for http:grpc (streaming)', () => {
    const listener = buildIngressListener({
      channelName: 'grpc-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      protocol: 'http:grpc',
    })
    const route =
      listener.filter_chains[0].filters[0].typed_config.route_config.virtual_hosts[0].routes[0]
        .route
    expect(route.timeout).toEqual({ seconds: 0, nanos: 0 })
  })

  it('does not add upgrade_configs for http:grpc', () => {
    const listener = buildIngressListener({
      channelName: 'grpc-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      protocol: 'http:grpc',
    })
    const hcm = listener.filter_chains[0].filters[0].typed_config
    expect(hcm.upgrade_configs).toBeUndefined()
  })

  it('enables websocket upgrade but no timeout for plain http', () => {
    const listener = buildIngressListener({
      channelName: 'rest-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      protocol: 'http',
    })
    const hcm = listener.filter_chains[0].filters[0].typed_config
    // WebSocket upgrade enabled by default for all HTTP listeners
    // (required for services using WebSocket RPC like orchestrator-rpc)
    expect(hcm.upgrade_configs).toEqual([{ upgrade_type: 'websocket' }])
    const route = hcm.route_config.virtual_hosts[0].routes[0].route
    expect(route.timeout).toBeUndefined()
  })

  it('applies protocol options to egress listeners too', () => {
    const listener = buildEgressListener({
      channelName: 'gql-api',
      peerName: 'node-a',
      port: 10001,
      protocol: 'http:graphql',
    })
    const hcm = listener.filter_chains[0].filters[0].typed_config
    expect(hcm.upgrade_configs).toEqual([{ upgrade_type: 'websocket' }])
    const route = hcm.route_config.virtual_hosts[0].routes[0].route
    expect(route.timeout).toEqual({ seconds: 0, nanos: 0 })
  })
})

describe('protocol-specific cluster config', () => {
  it('sets upstream_http2 for http:grpc local clusters', () => {
    const cluster = buildLocalCluster({
      channelName: 'grpc-api',
      address: '127.0.0.1',
      port: 5001,
      protocol: 'http:grpc',
    })
    expect(cluster.upstream_http2).toBe(true)
  })

  it('does not set upstream_http2 for http local clusters', () => {
    const cluster = buildLocalCluster({
      channelName: 'rest-api',
      address: '127.0.0.1',
      port: 5001,
      protocol: 'http',
    })
    expect(cluster.upstream_http2).toBeUndefined()
  })

  it('does not set upstream_http2 for http:graphql local clusters', () => {
    const cluster = buildLocalCluster({
      channelName: 'gql-api',
      address: '127.0.0.1',
      port: 5001,
      protocol: 'http:graphql',
    })
    expect(cluster.upstream_http2).toBeUndefined()
  })

  it('sets upstream_http2 for http:grpc remote clusters', () => {
    const cluster = buildRemoteCluster({
      channelName: 'grpc-api',
      peerName: 'node-a',
      peerAddress: '10.0.0.5',
      peerPort: 8001,
      protocol: 'http:grpc',
    })
    expect(cluster.upstream_http2).toBe(true)
  })

  it('does not set upstream_http2 for http remote clusters', () => {
    const cluster = buildRemoteCluster({
      channelName: 'rest-api',
      peerName: 'node-a',
      peerAddress: '10.0.0.5',
      peerPort: 8001,
      protocol: 'http',
    })
    expect(cluster.upstream_http2).toBeUndefined()
  })
})

describe('buildXdsSnapshot protocol-aware', () => {
  it('propagates protocol to ingress listener and local cluster for gRPC', () => {
    const snapshot = buildXdsSnapshot({
      local: [
        {
          name: 'grpc-svc',
          protocol: 'http:grpc',
          endpoint: 'http://localhost:50051',
          envoyPort: 8001,
        },
      ],
      internal: [],
      portAllocations: { 'grpc-svc': 8001 },
      bindAddress: '0.0.0.0',
      version: '1',
    })

    // Listener: route timeout disabled
    const route =
      snapshot.listeners[0].filter_chains[0].filters[0].typed_config.route_config.virtual_hosts[0]
        .routes[0].route
    expect(route.timeout).toEqual({ seconds: 0, nanos: 0 })

    // Cluster: HTTP/2 upstream enabled
    expect(snapshot.clusters[0].upstream_http2).toBe(true)
  })

  it('propagates protocol to egress listener and remote cluster for GraphQL', () => {
    const snapshot = buildXdsSnapshot({
      local: [],
      internal: [
        {
          name: 'gql-api',
          protocol: 'http:graphql',
          endpoint: 'http://peer:4000/graphql',
          envoyPort: 8002,
          peer: { name: 'node-a', envoyAddress: '10.0.0.5' },
          peerName: 'node-a',
          nodePath: ['local', 'node-a'],
        },
      ],
      portAllocations: { 'egress_gql-api_via_node-a': 10001 },
      bindAddress: '0.0.0.0',
      version: '1',
    })

    // Listener: WebSocket upgrade + timeout disabled
    const hcm = snapshot.listeners[0].filter_chains[0].filters[0].typed_config
    expect(hcm.upgrade_configs).toEqual([{ upgrade_type: 'websocket' }])
    const route = hcm.route_config.virtual_hosts[0].routes[0].route
    expect(route.timeout).toEqual({ seconds: 0, nanos: 0 })

    // Cluster: no HTTP/2 (GraphQL is HTTP/1.1)
    expect(snapshot.clusters[0].upstream_http2).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// buildTcpProxyIngressListener
// ---------------------------------------------------------------------------

describe('buildTcpProxyIngressListener', () => {
  it('creates listener named "ingress_<channelName>"', () => {
    const listener = buildTcpProxyIngressListener({
      channelName: 'redis-cache',
      port: 6379,
      bindAddress: '0.0.0.0',
    })
    expect(listener.name).toBe('ingress_redis-cache')
  })

  it('binds to given address and port', () => {
    const listener = buildTcpProxyIngressListener({
      channelName: 'redis-cache',
      port: 6379,
      bindAddress: '127.0.0.1',
    })
    const addr = listener.address.socket_address
    expect(addr.address).toBe('127.0.0.1')
    expect(addr.port_value).toBe(6379)
  })

  it('uses tcp_proxy filter', () => {
    const listener = buildTcpProxyIngressListener({
      channelName: 'redis-cache',
      port: 6379,
      bindAddress: '0.0.0.0',
    })
    const filter = listener.filter_chains[0].filters[0]
    expect(filter.name).toBe('envoy.filters.network.tcp_proxy')
  })

  it('routes to "local_<channelName>" cluster via typed_config.cluster', () => {
    const listener = buildTcpProxyIngressListener({
      channelName: 'redis-cache',
      port: 6379,
      bindAddress: '0.0.0.0',
    })
    const typedConfig = listener.filter_chains[0].filters[0].typed_config
    expect(typedConfig.cluster).toBe('local_redis-cache')
  })

  it('sets stat_prefix to "ingress_<channelName>"', () => {
    const listener = buildTcpProxyIngressListener({
      channelName: 'redis-cache',
      port: 6379,
      bindAddress: '0.0.0.0',
    })
    const typedConfig = listener.filter_chains[0].filters[0].typed_config
    expect(typedConfig.stat_prefix).toBe('ingress_redis-cache')
  })
})

// ---------------------------------------------------------------------------
// buildTcpProxyEgressListener
// ---------------------------------------------------------------------------

describe('buildTcpProxyEgressListener', () => {
  it('creates listener named "egress_<channelName>_via_<peerName>"', () => {
    const listener = buildTcpProxyEgressListener({
      channelName: 'redis-cache',
      peerName: 'node-b',
      port: 16379,
    })
    expect(listener.name).toBe('egress_redis-cache_via_node-b')
  })

  it('defaults bind address to 0.0.0.0', () => {
    const listener = buildTcpProxyEgressListener({
      channelName: 'redis-cache',
      peerName: 'node-b',
      port: 16379,
    })
    const addr = listener.address.socket_address
    expect(addr.address).toBe('0.0.0.0')
    expect(addr.port_value).toBe(16379)
  })

  it('routes to "remote_<channelName>_via_<peerName>" cluster via typed_config.cluster', () => {
    const listener = buildTcpProxyEgressListener({
      channelName: 'redis-cache',
      peerName: 'node-b',
      port: 16379,
    })
    const typedConfig = listener.filter_chains[0].filters[0].typed_config
    expect(typedConfig.cluster).toBe('remote_redis-cache_via_node-b')
  })
})

// ---------------------------------------------------------------------------
// isTcpProxyListener
// ---------------------------------------------------------------------------

describe('isTcpProxyListener', () => {
  it('returns true for TCP proxy listeners', () => {
    const listener = buildTcpProxyIngressListener({
      channelName: 'redis-cache',
      port: 6379,
      bindAddress: '0.0.0.0',
    })
    expect(isTcpProxyListener(listener)).toBe(true)
  })

  it('returns false for HCM listeners', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
    })
    expect(isTcpProxyListener(listener)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildXdsSnapshot with TCP protocol
// ---------------------------------------------------------------------------

describe('buildXdsSnapshot with TCP protocol', () => {
  it('creates TCP proxy ingress listener + local cluster for tcp protocol local routes', () => {
    const snapshot = buildXdsSnapshot({
      local: [
        {
          name: 'redis-cache',
          protocol: 'tcp',
          endpoint: 'http://localhost:6379',
          envoyPort: 6379,
        },
      ],
      internal: [],
      portAllocations: { 'redis-cache': 6379 },
      bindAddress: '0.0.0.0',
      version: '1',
    })

    expect(snapshot.listeners).toHaveLength(1)
    expect(snapshot.listeners[0].name).toBe('ingress_redis-cache')

    // Verify it is a TCP proxy listener, not HCM
    expect(isTcpProxyListener(snapshot.listeners[0])).toBe(true)
    const filter = snapshot.listeners[0].filter_chains[0].filters[0]
    expect(filter.name).toBe('envoy.filters.network.tcp_proxy')

    expect(snapshot.clusters).toHaveLength(1)
    expect(snapshot.clusters[0].name).toBe('local_redis-cache')
  })

  it('creates TCP proxy egress listener + remote cluster for tcp protocol internal routes', () => {
    const snapshot = buildXdsSnapshot({
      local: [],
      internal: [
        {
          name: 'redis-cache',
          protocol: 'tcp',
          endpoint: 'http://peer-node:6379',
          envoyPort: 6379,
          peer: { name: 'node-b', envoyAddress: '10.0.0.10' },
          peerName: 'node-b',
          nodePath: ['local-node', 'node-b'],
        },
      ],
      portAllocations: { 'egress_redis-cache_via_node-b': 16379 },
      bindAddress: '0.0.0.0',
      version: '1',
    })

    expect(snapshot.listeners).toHaveLength(1)
    expect(snapshot.listeners[0].name).toBe('egress_redis-cache_via_node-b')

    // Verify it is a TCP proxy listener
    expect(isTcpProxyListener(snapshot.listeners[0])).toBe(true)

    expect(snapshot.clusters).toHaveLength(1)
    expect(snapshot.clusters[0].name).toBe('remote_redis-cache_via_node-b')
  })

  it('mixed protocols: tcp and http routes produce correct listener types', () => {
    const snapshot = buildXdsSnapshot({
      local: [
        {
          name: 'redis-cache',
          protocol: 'tcp',
          endpoint: 'http://localhost:6379',
          envoyPort: 6379,
        },
        {
          name: 'books-api',
          protocol: 'http',
          endpoint: 'http://localhost:5001',
          envoyPort: 8001,
        },
      ],
      internal: [],
      portAllocations: { 'redis-cache': 6379, 'books-api': 8001 },
      bindAddress: '0.0.0.0',
      version: '1',
    })

    expect(snapshot.listeners).toHaveLength(2)
    expect(snapshot.clusters).toHaveLength(2)

    // Find each listener by name
    const tcpListener = snapshot.listeners.find((l) => l.name === 'ingress_redis-cache')!
    const httpListener = snapshot.listeners.find((l) => l.name === 'ingress_books-api')!

    expect(isTcpProxyListener(tcpListener)).toBe(true)
    expect(isTcpProxyListener(httpListener)).toBe(false)

    // TCP listener uses tcp_proxy filter
    expect(tcpListener.filter_chains[0].filters[0].name).toBe('envoy.filters.network.tcp_proxy')

    // HTTP listener uses http_connection_manager filter
    expect(httpListener.filter_chains[0].filters[0].name).toBe(
      'envoy.filters.network.http_connection_manager'
    )
  })
})

// ---------------------------------------------------------------------------
// TCP proxy listeners
// ---------------------------------------------------------------------------

describe('buildTcpProxyIngressListener', () => {
  it('creates a listener named "ingress_<channelName>"', () => {
    const listener = buildTcpProxyIngressListener({
      channelName: 'zenoh-bridge',
      port: 7447,
      bindAddress: '0.0.0.0',
    })
    expect(listener.name).toBe('ingress_zenoh-bridge')
  })

  it('uses tcp_proxy filter instead of http_connection_manager', () => {
    const listener = buildTcpProxyIngressListener({
      channelName: 'zenoh-bridge',
      port: 7447,
      bindAddress: '0.0.0.0',
    })
    expect(listener.filter_chains[0].filters[0].name).toBe('envoy.filters.network.tcp_proxy')
  })

  it('sets cluster reference to "local_<channelName>"', () => {
    const listener = buildTcpProxyIngressListener({
      channelName: 'zenoh-bridge',
      port: 7447,
      bindAddress: '0.0.0.0',
    })
    expect(listener.filter_chains[0].filters[0].typed_config.cluster).toBe('local_zenoh-bridge')
  })

  it('sets stat_prefix to the listener name', () => {
    const listener = buildTcpProxyIngressListener({
      channelName: 'zenoh-bridge',
      port: 7447,
      bindAddress: '0.0.0.0',
    })
    expect(listener.filter_chains[0].filters[0].typed_config.stat_prefix).toBe(
      'ingress_zenoh-bridge'
    )
  })

  it('binds to the given address and port', () => {
    const listener = buildTcpProxyIngressListener({
      channelName: 'zenoh-bridge',
      port: 7447,
      bindAddress: '0.0.0.0',
    })
    const addr = listener.address.socket_address
    expect(addr.address).toBe('0.0.0.0')
    expect(addr.port_value).toBe(7447)
  })
})

describe('buildTcpProxyEgressListener', () => {
  it('creates a listener named "egress_<channelName>_via_<peerName>"', () => {
    const listener = buildTcpProxyEgressListener({
      channelName: 'zenoh-bridge',
      peerName: 'node-a',
      port: 10001,
    })
    expect(listener.name).toBe('egress_zenoh-bridge_via_node-a')
  })

  it('uses tcp_proxy filter', () => {
    const listener = buildTcpProxyEgressListener({
      channelName: 'zenoh-bridge',
      peerName: 'node-a',
      port: 10001,
    })
    expect(listener.filter_chains[0].filters[0].name).toBe('envoy.filters.network.tcp_proxy')
  })

  it('sets cluster reference to "remote_<channelName>_via_<peerName>"', () => {
    const listener = buildTcpProxyEgressListener({
      channelName: 'zenoh-bridge',
      peerName: 'node-a',
      port: 10001,
    })
    expect(listener.filter_chains[0].filters[0].typed_config.cluster).toBe(
      'remote_zenoh-bridge_via_node-a'
    )
  })

  it('defaults bind address to 0.0.0.0', () => {
    const listener = buildTcpProxyEgressListener({
      channelName: 'zenoh-bridge',
      peerName: 'node-a',
      port: 10001,
    })
    expect(listener.address.socket_address.address).toBe('0.0.0.0')
  })
})

describe('isTcpProxyListener', () => {
  it('returns true for TCP proxy listeners', () => {
    const listener = buildTcpProxyIngressListener({
      channelName: 'zenoh-bridge',
      port: 7447,
      bindAddress: '0.0.0.0',
    })
    expect(isTcpProxyListener(listener)).toBe(true)
  })

  it('returns false for HCM listeners', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      protocol: 'http',
    })
    expect(isTcpProxyListener(listener)).toBe(false)
  })
})

describe('buildXdsSnapshot with TCP protocol', () => {
  it('uses TCP proxy listener for local tcp routes', () => {
    const snapshot = buildXdsSnapshot({
      local: [
        {
          name: 'zenoh-bridge',
          protocol: 'tcp',
          endpoint: 'http://localhost:7447',
          envoyPort: 7447,
        },
      ],
      internal: [],
      portAllocations: { 'zenoh-bridge': 7447 },
      bindAddress: '0.0.0.0',
      version: '1',
    })

    expect(snapshot.listeners).toHaveLength(1)
    expect(isTcpProxyListener(snapshot.listeners[0])).toBe(true)
    expect(snapshot.listeners[0].name).toBe('ingress_zenoh-bridge')
  })

  it('uses TCP proxy listener for internal tcp routes', () => {
    const snapshot = buildXdsSnapshot({
      local: [],
      internal: [
        {
          name: 'zenoh-bridge',
          protocol: 'tcp',
          endpoint: 'http://peer:7447',
          envoyPort: 7447,
          peer: { name: 'node-a', envoyAddress: '10.0.0.5' },
          peerName: 'node-a',
          nodePath: ['local', 'node-a'],
        },
      ],
      portAllocations: { 'egress_zenoh-bridge_via_node-a': 10001 },
      bindAddress: '0.0.0.0',
      version: '1',
    })

    expect(snapshot.listeners).toHaveLength(1)
    expect(isTcpProxyListener(snapshot.listeners[0])).toBe(true)
    expect(snapshot.listeners[0].name).toBe('egress_zenoh-bridge_via_node-a')
  })

  it('mixes TCP and HTTP listeners in the same snapshot', () => {
    const snapshot = buildXdsSnapshot({
      local: [
        {
          name: 'zenoh-bridge',
          protocol: 'tcp',
          endpoint: 'http://localhost:7447',
          envoyPort: 7447,
        },
        {
          name: 'rest-api',
          protocol: 'http',
          endpoint: 'http://localhost:5001',
          envoyPort: 8001,
        },
      ],
      internal: [],
      portAllocations: { 'zenoh-bridge': 7447, 'rest-api': 8001 },
      bindAddress: '0.0.0.0',
      version: '1',
    })

    expect(snapshot.listeners).toHaveLength(2)
    const tcpListener = snapshot.listeners.find((l) => l.name === 'ingress_zenoh-bridge')!
    const httpListener = snapshot.listeners.find((l) => l.name === 'ingress_rest-api')!
    expect(isTcpProxyListener(tcpListener)).toBe(true)
    expect(isTcpProxyListener(httpListener)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// TLS configuration
// ---------------------------------------------------------------------------

import type { XdsTlsConfig } from '../src/xds/resources.js'

const testTlsConfig: XdsTlsConfig = {
  certChain: '-----BEGIN CERTIFICATE-----\ntest-cert\n-----END CERTIFICATE-----',
  privateKey: '-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----',
  caBundle: '-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----',
}

describe('buildIngressListener with TLS', () => {
  it('adds transport_socket to filter chain when TLS is provided', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      tls: testTlsConfig,
    })

    const fc = listener.filter_chains[0]
    expect(fc.transport_socket).toBeDefined()
    expect(fc.transport_socket!.name).toBe('envoy.transport_sockets.tls')
    expect(fc.transport_socket!.typed_config['@type']).toContain('DownstreamTlsContext')
  })

  it('includes XFCC config in HCM when TLS is provided', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      tls: testTlsConfig,
    })

    const hcm = listener.filter_chains[0].filters[0].typed_config
    expect(hcm.forward_client_cert_details).toBe('SANITIZE_SET')
    expect(hcm.set_current_client_cert_details).toEqual({
      uri: true,
      subject: true,
      dns: true,
    })
  })

  it('does not add transport_socket when TLS is absent', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
    })

    expect(listener.filter_chains[0].transport_socket).toBeUndefined()
  })

  it('does not add XFCC config when TLS is absent', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
    })

    const hcm = listener.filter_chains[0].filters[0].typed_config
    expect(hcm.forward_client_cert_details).toBeUndefined()
    expect(hcm.set_current_client_cert_details).toBeUndefined()
  })

  it('sets TLS 1.3 minimum and PQ ecdh_curves', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      tls: testTlsConfig,
    })

    const ts = listener.filter_chains[0].transport_socket!
    const common = ts.typed_config.common_tls_context
    expect(common.tls_params.tls_minimum_protocol_version).toBe('TLSv1_3')
    expect(common.tls_params.ecdh_curves).toEqual(['X25519MLKEM768', 'X25519', 'P-256'])
  })

  it('requires client certificate by default (mTLS)', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      tls: testTlsConfig,
    })

    const ts = listener.filter_chains[0].transport_socket!
    expect(ts.typed_config.require_client_certificate).toBe(true)
  })

  it('respects custom ecdhCurves', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      tls: { ...testTlsConfig, ecdhCurves: ['X25519', 'P-256'] },
    })

    const ts = listener.filter_chains[0].transport_socket!
    expect(ts.typed_config.common_tls_context.tls_params.ecdh_curves).toEqual(['X25519', 'P-256'])
  })
})

describe('buildRemoteCluster with TLS', () => {
  it('adds transport_socket when TLS is provided', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-b',
      peerAddress: 'envoy-proxy-b',
      peerPort: 10000,
      tls: testTlsConfig,
    })

    expect(cluster.transport_socket).toBeDefined()
    expect(cluster.transport_socket!.name).toBe('envoy.transport_sockets.tls')
    expect(cluster.transport_socket!.typed_config['@type']).toContain('UpstreamTlsContext')
  })

  it('does not add transport_socket when TLS is absent', () => {
    const cluster = buildRemoteCluster({
      channelName: 'books-api',
      peerName: 'node-b',
      peerAddress: 'envoy-proxy-b',
      peerPort: 10000,
    })

    expect(cluster.transport_socket).toBeUndefined()
  })
})

describe('buildEgressListener with TLS (should NOT have TLS)', () => {
  it('egress listeners never have transport_socket', () => {
    const listener = buildEgressListener({
      channelName: 'books-api',
      peerName: 'node-b',
      port: 10001,
    })

    expect(listener.filter_chains[0].transport_socket).toBeUndefined()
  })
})

describe('buildXdsSnapshot with TLS', () => {
  it('passes TLS config to ingress listeners and remote clusters', () => {
    const snapshot = buildXdsSnapshot({
      local: [{ name: 'books', endpoint: 'http://books:8080', protocol: 'http' }],
      internal: [
        {
          name: 'movies',
          protocol: 'http',
          envoyPort: 10100,
          peer: { name: 'node-b', envoyAddress: 'envoy-proxy-b' },
          peerName: 'node-b',
          nodePath: ['node-b'],
        },
      ],
      portAllocations: { books: 10000, 'egress_movies_via_node-b': 10001 },
      bindAddress: '0.0.0.0',
      version: '1',
      tls: testTlsConfig,
    })

    // Ingress listener has DownstreamTlsContext
    const ingressListener = snapshot.listeners.find((l) => l.name === 'ingress_books')
    expect(ingressListener).toBeDefined()
    if (ingressListener && 'filter_chains' in ingressListener) {
      expect(ingressListener.filter_chains[0].transport_socket).toBeDefined()
    }

    // Remote cluster has UpstreamTlsContext
    const remoteCluster = snapshot.clusters.find((c) => c.name.startsWith('remote_'))
    expect(remoteCluster).toBeDefined()
    expect(remoteCluster!.transport_socket).toBeDefined()

    // Local cluster does NOT have TLS
    const localCluster = snapshot.clusters.find((c) => c.name.startsWith('local_'))
    expect(localCluster).toBeDefined()
    expect(localCluster!.transport_socket).toBeUndefined()
  })

  it('produces snapshot without TLS when not configured', () => {
    const snapshot = buildXdsSnapshot({
      local: [{ name: 'books', endpoint: 'http://books:8080', protocol: 'http' }],
      internal: [],
      portAllocations: { books: 10000 },
      bindAddress: '0.0.0.0',
      version: '1',
    })

    const listener = snapshot.listeners[0]
    if ('filter_chains' in listener) {
      expect(listener.filter_chains[0].transport_socket).toBeUndefined()
    }
  })
})
