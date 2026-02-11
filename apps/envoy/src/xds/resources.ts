import type { DataChannelDefinition, DataChannelProtocol } from '@catalyst/routing'
import type { XdsSnapshot } from './snapshot-cache.js'

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
        upgrade_configs?: Array<{ upgrade_type: string }>
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
}

/** Derive listener options from a data channel protocol. */
function getListenerOptions(protocol?: DataChannelProtocol): ListenerProtocolOptions {
  switch (protocol) {
    case 'http:graphql':
    case 'http:gql':
      return { enableWebSocket: true, disableRouteTimeout: true }
    case 'http:grpc':
      return { disableRouteTimeout: true }
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
    ...(options?.enableWebSocket && {
      upgrade_configs: [{ upgrade_type: 'websocket' }],
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
}): XdsListener {
  const name = `ingress_${opts.channelName}`
  const clusterName = `local_${opts.channelName}`
  const protocolOpts = getListenerOptions(opts.protocol)

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
            name: 'envoy.filters.network.http_connection_manager',
            typed_config: buildHttpConnectionManager(name, clusterName, protocolOpts),
          },
        ],
      },
    ],
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
      })
    )
  }

  return { version, listeners, clusters }
}
