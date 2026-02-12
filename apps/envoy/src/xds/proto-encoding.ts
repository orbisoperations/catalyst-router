import protobuf from 'protobufjs'
import type { XdsListener, XdsCluster } from './resources.js'

// ---------------------------------------------------------------------------
// Type URLs used for google.protobuf.Any wrapping
// ---------------------------------------------------------------------------

export const LISTENER_TYPE_URL = 'type.googleapis.com/envoy.config.listener.v3.Listener'
export const CLUSTER_TYPE_URL = 'type.googleapis.com/envoy.config.cluster.v3.Cluster'
const HCM_TYPE_URL =
  'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager'
const ROUTER_TYPE_URL = 'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router'
const HTTP_PROTOCOL_OPTIONS_TYPE_URL =
  'type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions'

// ---------------------------------------------------------------------------
// Enum constants
// ---------------------------------------------------------------------------

const CLUSTER_TYPE = { STATIC: 0, STRICT_DNS: 1 } as const

// ---------------------------------------------------------------------------
// Build the protobuf type hierarchy programmatically.
//
// Only the fields actually used by the resource builders are defined.
// Field numbers are taken from the upstream envoyproxy/envoy proto
// definitions (main branch, v3 API).
// ---------------------------------------------------------------------------

let _root: protobuf.Root | undefined

export function getProtoRoot(): protobuf.Root {
  if (_root) return _root
  _root = buildProtoRoot()
  return _root
}

/** Reset the cached root (for testing only). */
export function resetProtoRoot(): void {
  _root = undefined
}

function buildProtoRoot(): protobuf.Root {
  const root = new protobuf.Root()

  // google.protobuf.Any
  root
    .define('google.protobuf')
    .add(
      new protobuf.Type('Any')
        .add(new protobuf.Field('type_url', 1, 'string'))
        .add(new protobuf.Field('value', 2, 'bytes'))
    )

  // google.protobuf.Duration
  root
    .define('google.protobuf')
    .add(
      new protobuf.Type('Duration')
        .add(new protobuf.Field('seconds', 1, 'int64'))
        .add(new protobuf.Field('nanos', 2, 'int32'))
    )

  // google.rpc.Status (minimal — for DiscoveryRequest.error_detail)
  root
    .define('google.rpc')
    .add(
      new protobuf.Type('Status')
        .add(new protobuf.Field('code', 1, 'int32'))
        .add(new protobuf.Field('message', 2, 'string'))
    )

  // envoy.config.core.v3.SocketAddress
  root.define('envoy.config.core.v3').add(
    new protobuf.Type('SocketAddress')
      .add(new protobuf.Field('protocol', 1, 'int32'))
      .add(new protobuf.Field('address', 2, 'string'))
      .add(new protobuf.Field('port_value', 3, 'uint32'))
  )

  // envoy.config.core.v3.Address
  root
    .define('envoy.config.core.v3')
    .add(
      new protobuf.Type('Address').add(
        new protobuf.Field('socket_address', 1, 'envoy.config.core.v3.SocketAddress')
      )
    )

  // envoy.config.endpoint.v3
  root
    .define('envoy.config.endpoint.v3')
    .add(
      new protobuf.Type('Endpoint').add(
        new protobuf.Field('address', 1, 'envoy.config.core.v3.Address')
      )
    )

  root
    .define('envoy.config.endpoint.v3')
    .add(
      new protobuf.Type('LbEndpoint').add(
        new protobuf.Field('endpoint', 1, 'envoy.config.endpoint.v3.Endpoint')
      )
    )

  root
    .define('envoy.config.endpoint.v3')
    .add(
      new protobuf.Type('LocalityLbEndpoints').add(
        new protobuf.Field('lb_endpoints', 2, 'envoy.config.endpoint.v3.LbEndpoint', 'repeated')
      )
    )

  root
    .define('envoy.config.endpoint.v3')
    .add(
      new protobuf.Type('ClusterLoadAssignment')
        .add(new protobuf.Field('cluster_name', 1, 'string'))
        .add(
          new protobuf.Field(
            'endpoints',
            2,
            'envoy.config.endpoint.v3.LocalityLbEndpoints',
            'repeated'
          )
        )
    )

  // envoy.config.route.v3
  root
    .define('envoy.config.route.v3')
    .add(
      new protobuf.Type('RouteAction')
        .add(new protobuf.Field('cluster', 1, 'string'))
        .add(new protobuf.Field('timeout', 24, 'google.protobuf.Duration'))
    )

  root
    .define('envoy.config.route.v3')
    .add(new protobuf.Type('RouteMatch').add(new protobuf.Field('prefix', 1, 'string')))

  root
    .define('envoy.config.route.v3')
    .add(
      new protobuf.Type('Route')
        .add(new protobuf.Field('match', 1, 'envoy.config.route.v3.RouteMatch'))
        .add(new protobuf.Field('route', 2, 'envoy.config.route.v3.RouteAction'))
    )

  root.define('envoy.config.route.v3').add(
    new protobuf.Type('VirtualHost')
      .add(new protobuf.Field('name', 1, 'string'))
      .add(new protobuf.Field('domains', 2, 'string', 'repeated'))
      .add(new protobuf.Field('routes', 3, 'envoy.config.route.v3.Route', 'repeated'))
  )

  root
    .define('envoy.config.route.v3')
    .add(
      new protobuf.Type('RouteConfiguration')
        .add(new protobuf.Field('name', 1, 'string'))
        .add(
          new protobuf.Field('virtual_hosts', 2, 'envoy.config.route.v3.VirtualHost', 'repeated')
        )
    )

  // envoy.extensions.filters.http.router.v3.Router (empty message)
  root.define('envoy.extensions.filters.http.router.v3').add(new protobuf.Type('Router'))

  // envoy.extensions.filters.network.http_connection_manager.v3.HttpFilter
  root
    .define('envoy.extensions.filters.network.http_connection_manager.v3')
    .add(
      new protobuf.Type('HttpFilter')
        .add(new protobuf.Field('name', 1, 'string'))
        .add(new protobuf.Field('typed_config', 4, 'google.protobuf.Any'))
    )

  // envoy.extensions.filters.network.http_connection_manager.v3.UpgradeConfig
  root
    .define('envoy.extensions.filters.network.http_connection_manager.v3')
    .add(new protobuf.Type('UpgradeConfig').add(new protobuf.Field('upgrade_type', 1, 'string')))

  // envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
  root.define('envoy.extensions.filters.network.http_connection_manager.v3').add(
    new protobuf.Type('HttpConnectionManager')
      .add(new protobuf.Field('codec_type', 1, 'int32'))
      .add(new protobuf.Field('stat_prefix', 2, 'string'))
      .add(new protobuf.Field('route_config', 4, 'envoy.config.route.v3.RouteConfiguration'))
      .add(
        new protobuf.Field(
          'http_filters',
          5,
          'envoy.extensions.filters.network.http_connection_manager.v3.HttpFilter',
          'repeated'
        )
      )
      .add(
        new protobuf.Field(
          'upgrade_configs',
          23,
          'envoy.extensions.filters.network.http_connection_manager.v3.UpgradeConfig',
          'repeated'
        )
      )
  )

  // envoy.config.listener.v3.Filter
  root
    .define('envoy.config.listener.v3')
    .add(
      new protobuf.Type('Filter')
        .add(new protobuf.Field('name', 1, 'string'))
        .add(new protobuf.Field('typed_config', 4, 'google.protobuf.Any'))
    )

  // envoy.config.listener.v3.FilterChain
  root
    .define('envoy.config.listener.v3')
    .add(
      new protobuf.Type('FilterChain').add(
        new protobuf.Field('filters', 3, 'envoy.config.listener.v3.Filter', 'repeated')
      )
    )

  // envoy.config.listener.v3.Listener
  root.define('envoy.config.listener.v3').add(
    new protobuf.Type('Listener')
      .add(new protobuf.Field('name', 1, 'string'))
      .add(new protobuf.Field('address', 2, 'envoy.config.core.v3.Address'))
      .add(
        new protobuf.Field('filter_chains', 3, 'envoy.config.listener.v3.FilterChain', 'repeated')
      )
  )

  // envoy.config.core.v3.Http2ProtocolOptions (empty — defaults are fine)
  root.define('envoy.config.core.v3').add(new protobuf.Type('Http2ProtocolOptions'))

  // envoy.extensions.upstreams.http.v3.HttpProtocolOptions
  const HttpProtocolOptions = new protobuf.Type('HttpProtocolOptions')
  const ExplicitHttpConfig = new protobuf.Type('ExplicitHttpConfig').add(
    new protobuf.Field('http2_protocol_options', 2, 'envoy.config.core.v3.Http2ProtocolOptions')
  )
  HttpProtocolOptions.add(ExplicitHttpConfig)
  HttpProtocolOptions.add(
    new protobuf.Field(
      'explicit_http_config',
      3,
      'envoy.extensions.upstreams.http.v3.HttpProtocolOptions.ExplicitHttpConfig'
    )
  )
  root.define('envoy.extensions.upstreams.http.v3').add(HttpProtocolOptions)

  // envoy.config.cluster.v3.Cluster
  root.define('envoy.config.cluster.v3').add(
    new protobuf.Type('Cluster')
      .add(new protobuf.Field('name', 1, 'string'))
      .add(new protobuf.Field('type', 2, 'int32'))
      .add(new protobuf.Field('connect_timeout', 4, 'google.protobuf.Duration'))
      .add(new protobuf.Field('lb_policy', 6, 'int32'))
      .add(new protobuf.Field('dns_lookup_family', 17, 'int32'))
      .add(
        new protobuf.Field('load_assignment', 33, 'envoy.config.endpoint.v3.ClusterLoadAssignment')
      )
      .add(
        new protobuf.MapField(
          'typed_extension_protocol_options',
          36,
          'string',
          'google.protobuf.Any'
        )
      )
  )

  // envoy.service.discovery.v3.DiscoveryRequest
  root.define('envoy.service.discovery.v3').add(
    new protobuf.Type('DiscoveryRequest')
      .add(new protobuf.Field('version_info', 1, 'string'))
      .add(new protobuf.Field('resource_names', 3, 'string', 'repeated'))
      .add(new protobuf.Field('type_url', 4, 'string'))
      .add(new protobuf.Field('response_nonce', 5, 'string'))
  )

  // envoy.service.discovery.v3.DiscoveryResponse
  root.define('envoy.service.discovery.v3').add(
    new protobuf.Type('DiscoveryResponse')
      .add(new protobuf.Field('version_info', 1, 'string'))
      .add(new protobuf.Field('resources', 2, 'google.protobuf.Any', 'repeated'))
      .add(new protobuf.Field('type_url', 4, 'string'))
      .add(new protobuf.Field('nonce', 5, 'string'))
  )

  return root
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** Encode an inner message type and wrap it in google.protobuf.Any. */
function encodeAsAny(
  root: protobuf.Root,
  typeName: string,
  typeUrl: string,
  obj: Record<string, unknown>
): { type_url: string; value: Uint8Array } {
  const MsgType = root.lookupType(typeName)
  const msg = MsgType.fromObject(obj)
  const value = MsgType.encode(msg).finish()
  return { type_url: typeUrl, value }
}

/**
 * Encode an XdsListener JSON structure into protobuf bytes suitable for
 * wrapping in a DiscoveryResponse.resources Any field.
 */
export function encodeListener(listener: XdsListener): {
  type_url: string
  value: Uint8Array
} {
  const root = getProtoRoot()
  const RouterType = root.lookupType('envoy.extensions.filters.http.router.v3.Router')

  // Encode the Router filter as Any (empty message body)
  const routerAny = {
    type_url: ROUTER_TYPE_URL,
    value: RouterType.encode(RouterType.create()).finish(),
  }

  const protoListener = {
    name: listener.name,
    address: {
      socket_address: {
        address: listener.address.socket_address.address,
        port_value: listener.address.socket_address.port_value,
      },
    },
    filter_chains: listener.filter_chains.map((fc) => ({
      filters: fc.filters.map((f) => {
        // The typed_config has an '@type' field — encode the inner HCM message
        const { '@type': _typeUrl, ...hcmFields } = f.typed_config
        const hcmProto: Record<string, unknown> = {
          stat_prefix: hcmFields.stat_prefix,
          route_config: hcmFields.route_config,
          http_filters: [{ name: 'envoy.filters.http.router', typed_config: routerAny }],
        }
        if (hcmFields.upgrade_configs) {
          hcmProto.upgrade_configs = hcmFields.upgrade_configs
        }
        const hcmAny = encodeAsAny(
          root,
          'envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
          HCM_TYPE_URL,
          hcmProto
        )
        return {
          name: f.name,
          typed_config: hcmAny,
        }
      }),
    })),
  }

  const ListenerType = root.lookupType('envoy.config.listener.v3.Listener')
  const msg = ListenerType.fromObject(protoListener)
  return {
    type_url: LISTENER_TYPE_URL,
    value: ListenerType.encode(msg).finish(),
  }
}

/**
 * Encode an XdsCluster JSON structure into protobuf bytes suitable for
 * wrapping in a DiscoveryResponse.resources Any field.
 */
export function encodeCluster(cluster: XdsCluster): {
  type_url: string
  value: Uint8Array
} {
  const root = getProtoRoot()

  // Convert string type to enum int
  const typeInt = CLUSTER_TYPE[cluster.type] ?? 0

  // Convert connect_timeout string (e.g. "5s") to Duration
  const match = cluster.connect_timeout.match(/^(\d+)s$/)
  const seconds = match ? parseInt(match[1], 10) : 5

  const protoCluster: Record<string, unknown> = {
    name: cluster.name,
    type: typeInt,
    connect_timeout: { seconds, nanos: 0 },
    lb_policy: 0, // ROUND_ROBIN
    dns_lookup_family: cluster.dns_lookup_family ?? 0,
    load_assignment: cluster.load_assignment,
  }

  // HTTP/2 upstream: encode as typed_extension_protocol_options with HttpProtocolOptions
  if (cluster.upstream_http2) {
    const Http2Opts = root.lookupType('envoy.config.core.v3.Http2ProtocolOptions')
    const ExplicitConfig = root.lookupType(
      'envoy.extensions.upstreams.http.v3.HttpProtocolOptions.ExplicitHttpConfig'
    )
    const HttpProtoOpts = root.lookupType('envoy.extensions.upstreams.http.v3.HttpProtocolOptions')

    const explicitConfig = ExplicitConfig.fromObject({
      http2_protocol_options: Http2Opts.create(),
    })
    const httpProtoOpts = HttpProtoOpts.fromObject({
      explicit_http_config: explicitConfig,
    })

    protoCluster.typed_extension_protocol_options = {
      'envoy.extensions.upstreams.http.v3.HttpProtocolOptions': {
        type_url: HTTP_PROTOCOL_OPTIONS_TYPE_URL,
        value: HttpProtoOpts.encode(httpProtoOpts).finish(),
      },
    }
  }

  const ClusterType = root.lookupType('envoy.config.cluster.v3.Cluster')
  const msg = ClusterType.fromObject(protoCluster)
  return {
    type_url: CLUSTER_TYPE_URL,
    value: ClusterType.encode(msg).finish(),
  }
}

/**
 * Encode a DiscoveryResponse to protobuf bytes for the gRPC wire.
 */
export function encodeDiscoveryResponse(response: {
  version_info: string
  resources: Array<{ type_url: string; value: Uint8Array }>
  type_url: string
  nonce: string
}): Buffer {
  const root = getProtoRoot()
  const ResponseType = root.lookupType('envoy.service.discovery.v3.DiscoveryResponse')
  const msg = ResponseType.fromObject(response)
  return Buffer.from(ResponseType.encode(msg).finish())
}

/**
 * Decode a DiscoveryRequest from protobuf bytes received on the gRPC wire.
 */
export function decodeDiscoveryRequest(buffer: Buffer): {
  version_info: string
  resource_names: string[]
  type_url: string
  response_nonce: string
} {
  const root = getProtoRoot()
  const RequestType = root.lookupType('envoy.service.discovery.v3.DiscoveryRequest')
  const msg = RequestType.decode(buffer)
  return RequestType.toObject(msg, {
    defaults: true,
    arrays: true,
  }) as {
    version_info: string
    resource_names: string[]
    type_url: string
    response_nonce: string
  }
}
