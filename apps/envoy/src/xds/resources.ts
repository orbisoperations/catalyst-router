import type { DataChannelDefinition, DataChannelProtocol } from '@catalyst/routing'
import type { XdsSnapshot } from './snapshot-cache.js'

// ---------------------------------------------------------------------------
// TLS configuration
// ---------------------------------------------------------------------------

export interface XdsTlsConfig {
  certChain: string
  privateKey: string
  caBundle: string
  requireClientCert?: boolean
  ecdhCurves?: string[]
}

const DEFAULT_ECDH_CURVES = ['X25519MLKEM768', 'X25519', 'P-256']

export interface XdsTlsTransportSocket {
  name: 'envoy.transport_sockets.tls'
  typed_config: {
    '@type': string
    common_tls_context: {
      tls_params: {
        tls_minimum_protocol_version: string
        ecdh_curves: string[]
      }
      tls_certificates: Array<{
        certificate_chain: { inline_string: string }
        private_key: { inline_string: string }
      }>
      validation_context?: {
        trusted_ca: { inline_string: string }
      }
    }
    require_client_certificate?: boolean
  }
}

function buildDownstreamTlsTransportSocket(tls: XdsTlsConfig): XdsTlsTransportSocket {
  return {
    name: 'envoy.transport_sockets.tls',
    typed_config: {
      '@type': 'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext',
      common_tls_context: {
        tls_params: {
          tls_minimum_protocol_version: 'TLSv1_3',
          ecdh_curves: tls.ecdhCurves ?? DEFAULT_ECDH_CURVES,
        },
        tls_certificates: [
          {
            certificate_chain: { inline_string: tls.certChain },
            private_key: { inline_string: tls.privateKey },
          },
        ],
        validation_context: {
          trusted_ca: { inline_string: tls.caBundle },
        },
      },
      require_client_certificate: tls.requireClientCert ?? true,
    },
  }
}

function buildUpstreamTlsTransportSocket(tls: XdsTlsConfig): XdsTlsTransportSocket {
  return {
    name: 'envoy.transport_sockets.tls',
    typed_config: {
      '@type': 'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext',
      common_tls_context: {
        tls_params: {
          tls_minimum_protocol_version: 'TLSv1_3',
          ecdh_curves: tls.ecdhCurves ?? DEFAULT_ECDH_CURVES,
        },
        tls_certificates: [
          {
            certificate_chain: { inline_string: tls.certChain },
            private_key: { inline_string: tls.privateKey },
          },
        ],
        validation_context: {
          trusted_ca: { inline_string: tls.caBundle },
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// xDS JSON structure types (matching Envoy's JSON config format)
// ---------------------------------------------------------------------------

export interface XdsRouteAction {
  cluster: string
  timeout?: { seconds: number; nanos: number }
}

export interface XdsListener {
  name: string
  address: { socket_address: { address: string; port_value: number } }
  filter_chains: Array<{
    filters: Array<{
      name: string
      typed_config: {
        '@type': string
        stat_prefix: string
        codec_type?: 'AUTO' | 'HTTP1' | 'HTTP2'
        upgrade_configs?: Array<{ upgrade_type: string }>
        forward_client_cert_details?: string
        set_current_client_cert_details?: { uri: boolean; subject: boolean; dns: boolean }
        route_config: {
          virtual_hosts: Array<{
            name: string
            domains: string[]
            routes: Array<{
              match: { prefix: string }
              route: XdsRouteAction
            }>
          }>
        }
      }
    }>
    transport_socket?: XdsTlsTransportSocket
  }>
}

export interface XdsTcpProxyListener {
  name: string
  address: { socket_address: { address: string; port_value: number } }
  filter_chains: Array<{
    filters: Array<{
      name: 'envoy.filters.network.tcp_proxy'
      typed_config: {
        '@type': string
        stat_prefix: string
        cluster: string
      }
    }>
  }>
}

/** Type guard: returns true if the listener uses tcp_proxy instead of HCM. */
export function isTcpProxyListener(
  listener: XdsListener | XdsTcpProxyListener
): listener is XdsTcpProxyListener {
  return listener.filter_chains[0]?.filters[0]?.name === 'envoy.filters.network.tcp_proxy'
}

export interface XdsCluster {
  name: string
  type: 'STATIC' | 'STRICT_DNS'
  connect_timeout: string
  lb_policy: string
  dns_lookup_family?: number
  /** Enable HTTP/2 upstream (required for gRPC). */
  upstream_http2?: boolean
  /** TLS transport socket for upstream mTLS. */
  transport_socket?: XdsTlsTransportSocket
  load_assignment: {
    cluster_name: string
    endpoints: Array<{
      lb_endpoints: Array<{
        endpoint: {
          address: { socket_address: { address: string; port_value: number } }
        }
      }>
    }>
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HCM_TYPE_URL =
  'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager'

/** Envoy Cluster dns_lookup_family values */
const DnsLookupFamily = {
  AUTO: 0,
  V4_ONLY: 1,
  V6_ONLY: 2,
  V4_PREFERRED: 3,
  ALL: 4,
} as const

// ---------------------------------------------------------------------------
// IP detection — determines STATIC vs STRICT_DNS cluster type
// ---------------------------------------------------------------------------

import { isIP } from 'node:net'

function isIpAddress(address: string): boolean {
  return isIP(address) !== 0
}

// ---------------------------------------------------------------------------
// URL parsing helper
// ---------------------------------------------------------------------------

function parseEndpointUrl(endpoint: string): { address: string; port: number } {
  const url = new URL(endpoint)
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  return { address: url.hostname, port }
}

// ---------------------------------------------------------------------------
// Listener builders
// ---------------------------------------------------------------------------

/** Protocol-aware listener config options. */
interface ListenerProtocolOptions {
  /** Enable WebSocket upgrade support (for GraphQL subscriptions). */
  enableWebSocket?: boolean
  /** Disable route timeout for long-lived streams (SSE, gRPC streaming). */
  disableRouteTimeout?: boolean
  /** Set codec_type to restrict accepted HTTP versions (e.g. HTTP2 for gRPC). */
  codecType?: 'AUTO' | 'HTTP1' | 'HTTP2'
  /** XFCC forwarding mode (set by TLS-enabled ingress listeners). */
  forwardClientCertDetails?: string
  /** Which XFCC fields to include. */
  setCurrentClientCertDetails?: { uri: boolean; subject: boolean; dns: boolean }
}

/** Derive listener options from a data channel protocol. */
function getListenerOptions(protocol?: DataChannelProtocol): ListenerProtocolOptions {
  switch (protocol) {
    case 'http:graphql':
    case 'http:gql':
      return { enableWebSocket: true, disableRouteTimeout: true }
    case 'http:grpc':
      return { disableRouteTimeout: true, codecType: 'HTTP2' }
    default:
      return {}
  }
}

function buildHttpConnectionManager(
  statPrefix: string,
  clusterName: string,
  options?: ListenerProtocolOptions
): XdsListener['filter_chains'][0]['filters'][0]['typed_config'] {
  const routeAction: XdsRouteAction = { cluster: clusterName }
  if (options?.disableRouteTimeout) {
    routeAction.timeout = { seconds: 0, nanos: 0 }
  }

  return {
    '@type': HCM_TYPE_URL,
    stat_prefix: statPrefix,
    ...(options?.codecType && { codec_type: options.codecType }),
    ...(options?.enableWebSocket && {
      upgrade_configs: [{ upgrade_type: 'websocket' }],
    }),
    ...(options?.forwardClientCertDetails && {
      forward_client_cert_details: options.forwardClientCertDetails,
    }),
    ...(options?.setCurrentClientCertDetails && {
      set_current_client_cert_details: options.setCurrentClientCertDetails,
    }),
    route_config: {
      virtual_hosts: [
        {
          name: statPrefix.startsWith('ingress') ? 'local' : 'remote',
          domains: ['*'],
          routes: [
            {
              match: { prefix: '/' },
              route: routeAction,
            },
          ],
        },
      ],
    },
  }
}

export function buildIngressListener(opts: {
  channelName: string
  port: number
  bindAddress: string
  protocol?: DataChannelProtocol
  tls?: XdsTlsConfig
}): XdsListener {
  const name = `ingress_${opts.channelName}`
  const clusterName = `local_${opts.channelName}`
  const protocolOpts: ListenerProtocolOptions = {
    ...getListenerOptions(opts.protocol),
    ...(opts.tls && {
      forwardClientCertDetails: 'SANITIZE_SET',
      setCurrentClientCertDetails: { uri: true, subject: true, dns: true },
    }),
  }

  const filterChain: XdsListener['filter_chains'][0] = {
    filters: [
      {
        name: 'envoy.filters.network.http_connection_manager',
        typed_config: buildHttpConnectionManager(name, clusterName, protocolOpts),
      },
    ],
  }

  if (opts.tls) {
    filterChain.transport_socket = buildDownstreamTlsTransportSocket(opts.tls)
  }

  return {
    name,
    address: {
      socket_address: {
        address: opts.bindAddress,
        port_value: opts.port,
      },
    },
    filter_chains: [filterChain],
  }
}

export function buildEgressListener(opts: {
  channelName: string
  peerName: string
  port: number
  bindAddress?: string
  protocol?: DataChannelProtocol
}): XdsListener {
  const name = `egress_${opts.channelName}_via_${opts.peerName}`
  const clusterName = `remote_${opts.channelName}_via_${opts.peerName}`

  return {
    name,
    address: {
      socket_address: {
        address: opts.bindAddress ?? '0.0.0.0',
        port_value: opts.port,
      },
    },
    filter_chains: [
      {
        filters: [
          {
            name: 'envoy.filters.network.http_connection_manager',
            typed_config: buildHttpConnectionManager(
              name,
              clusterName,
              getListenerOptions(opts.protocol)
            ),
          },
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// TCP proxy listener builders (raw L4 passthrough)
// ---------------------------------------------------------------------------

const TCP_PROXY_TYPE_URL =
  'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy'

/** Returns true if the protocol should use a raw TCP proxy instead of HCM. */
function isTcpProtocol(protocol?: DataChannelProtocol): boolean {
  return protocol === 'tcp'
}

export function buildTcpProxyIngressListener(opts: {
  channelName: string
  port: number
  bindAddress: string
}): XdsTcpProxyListener {
  const name = `ingress_${opts.channelName}`
  const clusterName = `local_${opts.channelName}`

  return {
    name,
    address: {
      socket_address: {
        address: opts.bindAddress,
        port_value: opts.port,
      },
    },
    filter_chains: [
      {
        filters: [
          {
            name: 'envoy.filters.network.tcp_proxy',
            typed_config: {
              '@type': TCP_PROXY_TYPE_URL,
              stat_prefix: name,
              cluster: clusterName,
            },
          },
        ],
      },
    ],
  }
}

export function buildTcpProxyEgressListener(opts: {
  channelName: string
  peerName: string
  port: number
  bindAddress?: string
}): XdsTcpProxyListener {
  const name = `egress_${opts.channelName}_via_${opts.peerName}`
  const clusterName = `remote_${opts.channelName}_via_${opts.peerName}`

  return {
    name,
    address: {
      socket_address: {
        address: opts.bindAddress ?? '0.0.0.0',
        port_value: opts.port,
      },
    },
    filter_chains: [
      {
        filters: [
          {
            name: 'envoy.filters.network.tcp_proxy',
            typed_config: {
              '@type': TCP_PROXY_TYPE_URL,
              stat_prefix: name,
              cluster: clusterName,
            },
          },
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Cluster builders
// ---------------------------------------------------------------------------

/** Returns true if the protocol requires HTTP/2 upstream (e.g. gRPC). */
function requiresHttp2(protocol?: DataChannelProtocol): boolean {
  return protocol === 'http:grpc'
}

export function buildLocalCluster(opts: {
  channelName: string
  address: string
  port: number
  protocol?: DataChannelProtocol
}): XdsCluster {
  const name = `local_${opts.channelName}`
  const clusterType = isIpAddress(opts.address) ? 'STATIC' : 'STRICT_DNS'
  return {
    name,
    type: clusterType,
    connect_timeout: '5s',
    lb_policy: 'ROUND_ROBIN',
    ...(clusterType === 'STRICT_DNS' && { dns_lookup_family: DnsLookupFamily.V4_ONLY }),
    ...(requiresHttp2(opts.protocol) && { upstream_http2: true }),
    load_assignment: {
      cluster_name: name,
      endpoints: [
        {
          lb_endpoints: [
            {
              endpoint: {
                address: {
                  socket_address: {
                    address: opts.address,
                    port_value: opts.port,
                  },
                },
              },
            },
          ],
        },
      ],
    },
  }
}

export function buildRemoteCluster(opts: {
  channelName: string
  peerName: string
  peerAddress: string
  peerPort: number
  protocol?: DataChannelProtocol
  tls?: XdsTlsConfig
}): XdsCluster {
  const name = `remote_${opts.channelName}_via_${opts.peerName}`
  const clusterType = isIpAddress(opts.peerAddress) ? 'STATIC' : 'STRICT_DNS'

  return {
    name,
    type: clusterType,
    connect_timeout: '5s',
    lb_policy: 'ROUND_ROBIN',
    ...(clusterType === 'STRICT_DNS' && { dns_lookup_family: DnsLookupFamily.V4_ONLY }),
    ...(requiresHttp2(opts.protocol) && { upstream_http2: true }),
    ...(opts.tls && { transport_socket: buildUpstreamTlsTransportSocket(opts.tls) }),
    load_assignment: {
      cluster_name: name,
      endpoints: [
        {
          lb_endpoints: [
            {
              endpoint: {
                address: {
                  socket_address: {
                    address: opts.peerAddress,
                    port_value: opts.peerPort,
                  },
                },
              },
            },
          ],
        },
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// Internal route type (matches InternalRouteSchema from rpc/server.ts)
// ---------------------------------------------------------------------------

interface InternalRoute extends DataChannelDefinition {
  peer: { name: string; envoyAddress?: string }
  peerName: string
  nodePath: string[]
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

export interface BuildXdsSnapshotInput {
  local: DataChannelDefinition[]
  internal: InternalRoute[]
  portAllocations: Record<string, number>
  bindAddress: string
  version: string
  tls?: XdsTlsConfig
}

/**
 * Build a complete xDS snapshot from route config and port allocations.
 *
 * Creates:
 * - Ingress listener + local cluster for each local route (with endpoint)
 * - Egress listener + remote cluster for each internal route (with envoyPort + peer address)
 *
 * Protocol branching:
 * - `tcp` → raw TCP proxy listener (L4 passthrough, no HCM)
 * - all others → HTTP connection manager listener (L7)
 */
export function buildXdsSnapshot(input: BuildXdsSnapshotInput): XdsSnapshot {
  const version = input.version

  const listeners: Array<XdsListener | XdsTcpProxyListener> = []
  const clusters: XdsCluster[] = []

  // Local routes -> ingress listeners + local clusters
  for (const route of input.local) {
    if (!route.endpoint) continue
    const allocatedPort = input.portAllocations[route.name]
    if (!allocatedPort) continue

    const { address, port } = parseEndpointUrl(route.endpoint)

    if (isTcpProtocol(route.protocol)) {
      listeners.push(
        buildTcpProxyIngressListener({
          channelName: route.name,
          port: allocatedPort,
          bindAddress: input.bindAddress,
        })
      )
    } else {
      listeners.push(
        buildIngressListener({
          channelName: route.name,
          port: allocatedPort,
          bindAddress: input.bindAddress,
          protocol: route.protocol,
          tls: input.tls,
        })
      )
    }

    clusters.push(
      buildLocalCluster({
        channelName: route.name,
        address,
        port,
        protocol: route.protocol,
      })
    )
  }

  // Internal routes -> egress listeners + remote clusters
  for (const route of input.internal) {
    if (!route.envoyPort) continue
    const peerAddress = route.peer.envoyAddress
    if (!peerAddress) continue

    const egressKey = `egress_${route.name}_via_${route.peerName}`
    const egressPort = input.portAllocations[egressKey]
    if (!egressPort) continue

    if (isTcpProtocol(route.protocol)) {
      listeners.push(
        buildTcpProxyEgressListener({
          channelName: route.name,
          peerName: route.peerName,
          port: egressPort,
          bindAddress: input.bindAddress,
        })
      )
    } else {
      listeners.push(
        buildEgressListener({
          channelName: route.name,
          peerName: route.peerName,
          port: egressPort,
          bindAddress: input.bindAddress,
          protocol: route.protocol,
        })
      )
    }

    clusters.push(
      buildRemoteCluster({
        channelName: route.name,
        peerName: route.peerName,
        peerAddress,
        peerPort: route.envoyPort,
        protocol: route.protocol,
        tls: input.tls,
      })
    )
  }

  return { version, listeners, clusters }
}
