import { describe, it, expect } from 'bun:test'
import {
  getProtoRoot,
  encodeListener,
  encodeCluster,
  encodeDiscoveryResponse,
  decodeDiscoveryRequest,
  LISTENER_TYPE_URL,
  CLUSTER_TYPE_URL,
} from '../src/xds/proto-encoding.js'
import {
  buildIngressListener,
  buildEgressListener,
  buildLocalCluster,
  buildRemoteCluster,
} from '../src/xds/resources.js'

// ---------------------------------------------------------------------------
// Proto root structure
// ---------------------------------------------------------------------------

describe('getProtoRoot', () => {
  it('resolves all required types without errors', () => {
    const root = getProtoRoot()
    expect(() => root.lookupType('envoy.config.listener.v3.Listener')).not.toThrow()
    expect(() => root.lookupType('envoy.config.cluster.v3.Cluster')).not.toThrow()
    expect(() => root.lookupType('envoy.service.discovery.v3.DiscoveryResponse')).not.toThrow()
    expect(() => root.lookupType('envoy.service.discovery.v3.DiscoveryRequest')).not.toThrow()
  })

  it('includes HTTP/2 protocol options types', () => {
    const root = getProtoRoot()
    expect(() => root.lookupType('envoy.config.core.v3.Http2ProtocolOptions')).not.toThrow()
    expect(() =>
      root.lookupType('envoy.extensions.upstreams.http.v3.HttpProtocolOptions.ExplicitHttpConfig')
    ).not.toThrow()
    expect(() =>
      root.lookupType('envoy.extensions.upstreams.http.v3.HttpProtocolOptions')
    ).not.toThrow()
  })

  it('includes UpgradeConfig type for WebSocket support', () => {
    const root = getProtoRoot()
    expect(() =>
      root.lookupType('envoy.extensions.filters.network.http_connection_manager.v3.UpgradeConfig')
    ).not.toThrow()
  })

  it('includes Cluster typed_extension_protocol_options map field', () => {
    const root = getProtoRoot()
    const ClusterType = root.lookupType('envoy.config.cluster.v3.Cluster')
    const field = ClusterType.fields['typed_extension_protocol_options']
    expect(field).toBeDefined()
    expect(field.id).toBe(36)
  })

  it('includes RouteAction timeout field', () => {
    const root = getProtoRoot()
    const RouteAction = root.lookupType('envoy.config.route.v3.RouteAction')
    const field = RouteAction.fields['timeout']
    expect(field).toBeDefined()
    expect(field.id).toBe(24)
  })
})

// ---------------------------------------------------------------------------
// Listener encoding
// ---------------------------------------------------------------------------

describe('encodeListener', () => {
  it('encodes a basic HTTP listener to protobuf', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      protocol: 'http',
    })
    const result = encodeListener(listener)
    expect(result.type_url).toBe(LISTENER_TYPE_URL)
    expect(result.value).toBeInstanceOf(Uint8Array)
    expect(result.value.length).toBeGreaterThan(0)
  })

  it('roundtrips a listener through encode/decode', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      protocol: 'http',
    })
    const encoded = encodeListener(listener)

    const root = getProtoRoot()
    const ListenerType = root.lookupType('envoy.config.listener.v3.Listener')
    const decoded = ListenerType.toObject(ListenerType.decode(encoded.value), {
      defaults: true,
      arrays: true,
    }) as { name: string; address: { socket_address: { address: string; port_value: number } } }

    expect(decoded.name).toBe('ingress_books-api')
    expect(decoded.address.socket_address.address).toBe('0.0.0.0')
    expect(decoded.address.socket_address.port_value).toBe(8001)
  })

  it('encodes WebSocket upgrade_configs for GraphQL listeners', () => {
    const listener = buildIngressListener({
      channelName: 'gql-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      protocol: 'http:graphql',
    })
    const encoded = encodeListener(listener)

    // Decode the listener
    const root = getProtoRoot()
    const ListenerType = root.lookupType('envoy.config.listener.v3.Listener')
    const decoded = ListenerType.toObject(ListenerType.decode(encoded.value), {
      defaults: true,
      arrays: true,
    }) as Record<string, unknown>

    // Navigate to the HCM filter's typed_config (it's an Any)
    const filterChains = decoded.filter_chains as Array<{
      filters: Array<{ name: string; typed_config: { type_url: string; value: Uint8Array } }>
    }>
    const hcmAny = filterChains[0].filters[0].typed_config

    // Decode the HCM Any value
    const HcmType = root.lookupType(
      'envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager'
    )
    const hcm = HcmType.toObject(HcmType.decode(hcmAny.value), {
      defaults: true,
      arrays: true,
    }) as { upgrade_configs: Array<{ upgrade_type: string }> }

    expect(hcm.upgrade_configs).toHaveLength(1)
    expect(hcm.upgrade_configs[0].upgrade_type).toBe('websocket')
  })

  it('encodes route timeout: 0 for gRPC listeners', () => {
    const listener = buildIngressListener({
      channelName: 'grpc-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      protocol: 'http:grpc',
    })
    const encoded = encodeListener(listener)

    const root = getProtoRoot()
    const ListenerType = root.lookupType('envoy.config.listener.v3.Listener')
    const decoded = ListenerType.toObject(ListenerType.decode(encoded.value), {
      defaults: true,
      arrays: true,
    }) as Record<string, unknown>

    const filterChains = decoded.filter_chains as Array<{
      filters: Array<{ typed_config: { value: Uint8Array } }>
    }>
    const hcmAny = filterChains[0].filters[0].typed_config

    const HcmType = root.lookupType(
      'envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager'
    )
    const hcm = HcmType.toObject(HcmType.decode(hcmAny.value), {
      defaults: true,
      arrays: true,
    }) as {
      route_config: {
        virtual_hosts: Array<{
          routes: Array<{
            route: { cluster: string; timeout: { seconds: number | string; nanos: number } }
          }>
        }>
      }
    }

    const routeAction = hcm.route_config.virtual_hosts[0].routes[0].route
    expect(routeAction.timeout).toBeDefined()
    // Duration seconds may be a Long or number depending on protobufjs
    expect(Number(routeAction.timeout.seconds)).toBe(0)
    expect(routeAction.timeout.nanos).toBe(0)
  })

  it('encodes egress listener with protocol options', () => {
    const listener = buildEgressListener({
      channelName: 'gql-api',
      peerName: 'node-a',
      port: 10001,
      protocol: 'http:graphql',
    })
    const encoded = encodeListener(listener)

    const root = getProtoRoot()
    const ListenerType = root.lookupType('envoy.config.listener.v3.Listener')
    const decoded = ListenerType.toObject(ListenerType.decode(encoded.value), {
      defaults: true,
      arrays: true,
    }) as { name: string }

    expect(decoded.name).toBe('egress_gql-api_via_node-a')
    expect(encoded.value.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Cluster encoding
// ---------------------------------------------------------------------------

describe('encodeCluster', () => {
  it('encodes a basic HTTP cluster to protobuf', () => {
    const cluster = buildLocalCluster({
      channelName: 'books-api',
      address: '127.0.0.1',
      port: 5001,
      protocol: 'http',
    })
    const result = encodeCluster(cluster)
    expect(result.type_url).toBe(CLUSTER_TYPE_URL)
    expect(result.value).toBeInstanceOf(Uint8Array)
    expect(result.value.length).toBeGreaterThan(0)
  })

  it('roundtrips a cluster through encode/decode', () => {
    const cluster = buildLocalCluster({
      channelName: 'books-api',
      address: '127.0.0.1',
      port: 5001,
      protocol: 'http',
    })
    const encoded = encodeCluster(cluster)

    const root = getProtoRoot()
    const ClusterType = root.lookupType('envoy.config.cluster.v3.Cluster')
    const decoded = ClusterType.toObject(ClusterType.decode(encoded.value), {
      defaults: true,
      arrays: true,
    }) as { name: string; type: number }

    expect(decoded.name).toBe('local_books-api')
    expect(decoded.type).toBe(0) // STATIC
  })

  it('encodes STRICT_DNS cluster with dns_lookup_family', () => {
    const cluster = buildLocalCluster({
      channelName: 'books-api',
      address: 'books.internal',
      port: 5001,
      protocol: 'http',
    })
    const encoded = encodeCluster(cluster)

    const root = getProtoRoot()
    const ClusterType = root.lookupType('envoy.config.cluster.v3.Cluster')
    const decoded = ClusterType.toObject(ClusterType.decode(encoded.value), {
      defaults: true,
    }) as { type: number; dns_lookup_family: number }

    expect(decoded.type).toBe(1) // STRICT_DNS
    expect(decoded.dns_lookup_family).toBe(1) // V4_ONLY
  })

  it('encodes HTTP/2 typed_extension_protocol_options for gRPC clusters', () => {
    const cluster = buildLocalCluster({
      channelName: 'grpc-api',
      address: '127.0.0.1',
      port: 50051,
      protocol: 'http:grpc',
    })
    const encoded = encodeCluster(cluster)

    const root = getProtoRoot()
    const ClusterType = root.lookupType('envoy.config.cluster.v3.Cluster')
    const decoded = ClusterType.toObject(ClusterType.decode(encoded.value), {
      defaults: true,
      arrays: true,
    }) as {
      name: string
      typed_extension_protocol_options: Record<string, { type_url: string; value: Uint8Array }>
    }

    expect(decoded.name).toBe('local_grpc-api')

    // Verify typed_extension_protocol_options exists with the correct key
    const opts = decoded.typed_extension_protocol_options
    expect(opts).toBeDefined()
    const httpOpts = opts['envoy.extensions.upstreams.http.v3.HttpProtocolOptions']
    expect(httpOpts).toBeDefined()
    expect(httpOpts.type_url).toBe(
      'type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions'
    )

    // Decode the inner HttpProtocolOptions to verify it contains explicit_http_config
    const HttpProtoOpts = root.lookupType('envoy.extensions.upstreams.http.v3.HttpProtocolOptions')
    const innerDecoded = HttpProtoOpts.toObject(HttpProtoOpts.decode(httpOpts.value), {
      defaults: true,
    }) as {
      explicit_http_config: {
        http2_protocol_options: Record<string, unknown>
      }
    }

    expect(innerDecoded.explicit_http_config).toBeDefined()
    expect(innerDecoded.explicit_http_config.http2_protocol_options).toBeDefined()
  })

  it('does not include typed_extension_protocol_options for non-gRPC clusters', () => {
    const cluster = buildLocalCluster({
      channelName: 'rest-api',
      address: '127.0.0.1',
      port: 5001,
      protocol: 'http',
    })
    const encoded = encodeCluster(cluster)

    const root = getProtoRoot()
    const ClusterType = root.lookupType('envoy.config.cluster.v3.Cluster')
    const decoded = ClusterType.toObject(ClusterType.decode(encoded.value), {
      defaults: true,
      arrays: true,
    }) as {
      typed_extension_protocol_options: Record<string, unknown>
    }

    // Should be empty map (defaults: true gives empty object for map fields)
    const opts = decoded.typed_extension_protocol_options
    expect(Object.keys(opts)).toHaveLength(0)
  })

  it('encodes gRPC remote cluster with HTTP/2', () => {
    const cluster = buildRemoteCluster({
      channelName: 'grpc-api',
      peerName: 'node-a',
      peerAddress: '10.0.0.5',
      peerPort: 50051,
      protocol: 'http:grpc',
    })
    const encoded = encodeCluster(cluster)

    const root = getProtoRoot()
    const ClusterType = root.lookupType('envoy.config.cluster.v3.Cluster')
    const decoded = ClusterType.toObject(ClusterType.decode(encoded.value), {
      defaults: true,
      arrays: true,
    }) as {
      name: string
      typed_extension_protocol_options: Record<string, { type_url: string }>
    }

    expect(decoded.name).toBe('remote_grpc-api_via_node-a')
    const opts = decoded.typed_extension_protocol_options
    expect(opts['envoy.extensions.upstreams.http.v3.HttpProtocolOptions']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// DiscoveryResponse / DiscoveryRequest roundtrip
// ---------------------------------------------------------------------------

describe('DiscoveryResponse encoding', () => {
  it('encodes a response with listener and cluster resources', () => {
    const listener = buildIngressListener({
      channelName: 'books-api',
      port: 8001,
      bindAddress: '0.0.0.0',
      protocol: 'http',
    })
    const cluster = buildLocalCluster({
      channelName: 'books-api',
      address: '127.0.0.1',
      port: 5001,
      protocol: 'http',
    })

    const encodedListener = encodeListener(listener)
    const encodedCluster = encodeCluster(cluster)

    const ldsResponse = encodeDiscoveryResponse({
      version_info: '1',
      resources: [encodedListener],
      type_url: LISTENER_TYPE_URL,
      nonce: 'lds-1',
    })
    expect(ldsResponse).toBeInstanceOf(Buffer)
    expect(ldsResponse.length).toBeGreaterThan(0)

    const cdsResponse = encodeDiscoveryResponse({
      version_info: '1',
      resources: [encodedCluster],
      type_url: CLUSTER_TYPE_URL,
      nonce: 'cds-1',
    })
    expect(cdsResponse).toBeInstanceOf(Buffer)
    expect(cdsResponse.length).toBeGreaterThan(0)
  })
})

describe('DiscoveryRequest decoding', () => {
  it('roundtrips a request through encode/decode', () => {
    const root = getProtoRoot()
    const RequestType = root.lookupType('envoy.service.discovery.v3.DiscoveryRequest')
    const msg = RequestType.fromObject({
      type_url: CLUSTER_TYPE_URL,
      version_info: 'v1',
      response_nonce: 'n1',
      resource_names: ['cluster-a', 'cluster-b'],
    })
    const encoded = Buffer.from(RequestType.encode(msg).finish())

    const decoded = decodeDiscoveryRequest(encoded)
    expect(decoded.type_url).toBe(CLUSTER_TYPE_URL)
    expect(decoded.version_info).toBe('v1')
    expect(decoded.response_nonce).toBe('n1')
    expect(decoded.resource_names).toEqual(['cluster-a', 'cluster-b'])
  })
})
