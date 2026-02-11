import type { DataChannelDefinition } from '@catalyst/routing'
import type { XdsSnapshot } from './snapshot-cache.js'

// ---------------------------------------------------------------------------
// xDS JSON structure types (matching Envoy's JSON config format)
// ---------------------------------------------------------------------------

export interface XdsListener {
  name: string
  address: { socket_address: { address: string; port_value: number } }
  filter_chains: Array<{
    filters: Array<{
      name: string
      typed_config: {
        '@type': string
        stat_prefix: string
        route_config: {
          virtual_hosts: Array<{
            name: string
            domains: string[]
            routes: Array<{
              match: { prefix: string }
              route: { cluster: string }
            }>
          }>
        }
      }
    }>
  }>
}

export interface XdsCluster {
  name: string
  type: 'STATIC' | 'STRICT_DNS'
  connect_timeout: string
  lb_policy: string
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

// ---------------------------------------------------------------------------
// IP detection — determines STATIC vs STRICT_DNS cluster type
// ---------------------------------------------------------------------------

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/
const IPV6_RE = /^[0-9a-fA-F:]+$/

function isIpAddress(address: string): boolean {
  return IPV4_RE.test(address) || IPV6_RE.test(address)
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

function buildHttpConnectionManager(
  statPrefix: string,
  clusterName: string
): XdsListener['filter_chains'][0]['filters'][0]['typed_config'] {
  return {
    '@type': HCM_TYPE_URL,
    stat_prefix: statPrefix,
    route_config: {
      virtual_hosts: [
        {
          name: statPrefix.startsWith('ingress') ? 'local' : 'remote',
          domains: ['*'],
          routes: [
            {
              match: { prefix: '/' },
              route: { cluster: clusterName },
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
}): XdsListener {
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
            name: 'envoy.filters.network.http_connection_manager',
            typed_config: buildHttpConnectionManager(name, clusterName),
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
}): XdsListener {
  const name = `egress_${opts.channelName}_via_${opts.peerName}`
  const clusterName = `remote_${opts.channelName}_via_${opts.peerName}`

  return {
    name,
    address: {
      socket_address: {
        address: '127.0.0.1',
        port_value: opts.port,
      },
    },
    filter_chains: [
      {
        filters: [
          {
            name: 'envoy.filters.network.http_connection_manager',
            typed_config: buildHttpConnectionManager(name, clusterName),
          },
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Cluster builders
// ---------------------------------------------------------------------------

export function buildLocalCluster(opts: {
  channelName: string
  address: string
  port: number
}): XdsCluster {
  const name = `local_${opts.channelName}`
  const clusterType = isIpAddress(opts.address) ? 'STATIC' : 'STRICT_DNS'
  return {
    name,
    type: clusterType,
    connect_timeout: '5s',
    lb_policy: 'ROUND_ROBIN',
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
}): XdsCluster {
  const name = `remote_${opts.channelName}_via_${opts.peerName}`
  const clusterType = isIpAddress(opts.peerAddress) ? 'STATIC' : 'STRICT_DNS'

  return {
    name,
    type: clusterType,
    connect_timeout: '5s',
    lb_policy: 'ROUND_ROBIN',
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
 */
export function buildXdsSnapshot(input: BuildXdsSnapshotInput): XdsSnapshot {
  const version = input.version

  const listeners: XdsListener[] = []
  const clusters: XdsCluster[] = []

  // Local routes -> ingress listeners + local clusters
  for (const route of input.local) {
    if (!route.endpoint) continue
    const allocatedPort = input.portAllocations[route.name]
    if (!allocatedPort) continue

    const { address, port } = parseEndpointUrl(route.endpoint)

    listeners.push(
      buildIngressListener({
        channelName: route.name,
        port: allocatedPort,
        bindAddress: input.bindAddress,
      })
    )

    clusters.push(
      buildLocalCluster({
        channelName: route.name,
        address,
        port,
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

    listeners.push(
      buildEgressListener({
        channelName: route.name,
        peerName: route.peerName,
        port: egressPort,
      })
    )

    clusters.push(
      buildRemoteCluster({
        channelName: route.name,
        peerName: route.peerName,
        peerAddress,
        peerPort: route.envoyPort,
      })
    )
  }

  return { version, listeners, clusters }
}
