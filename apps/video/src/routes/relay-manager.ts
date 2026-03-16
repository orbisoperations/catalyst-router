/**
 * Relay manager: subscribes to route changes and configures MediaMTX relay paths.
 *
 * When a remote media route is added, creates an on-demand relay path so
 * consumers on this node can access the stream without knowing the origin.
 * When a remote media route is removed, deletes the relay path.
 *
 * SSRF VALIDATION (F-03): A compromised peer can advertise
 * `endpoint: "rtsp://169.254.169.254/..."` and turn every consuming node
 * into an SSRF proxy against cloud metadata services or internal networks.
 * Validation accepts only `rtsp://` scheme, checks the host against known
 * peer addresses, and blocklists cloud metadata and link-local IPs.
 *
 * On WebSocket reconnect, the manager performs a full reconciliation pass:
 * fetches all routes via listRoutes(), diffs against active relay paths,
 * and converges to the correct state before resubscribing to deltas.
 */

import { getLogger } from '@catalyst/telemetry'
import type { ControlApiClient } from '../mediamtx/control-api-client.js'
import type { RouteChange, DataChannelDefinition, InternalRoute } from '@catalyst/routing/v2'

const logger = getLogger(['catalyst', 'video', 'relay'])

// ---------------------------------------------------------------------------
// Interfaces — dependency injection for testability
// ---------------------------------------------------------------------------

export interface RouteSubscription {
  watchRoutes(callback: (changes: RouteChange[]) => void): () => void
  listRoutes(): Promise<{ local: DataChannelDefinition[]; internal: InternalRoute[] }>
}

export interface RelayManagerOptions {
  routeSource: RouteSubscription
  controlApi: ControlApiClient
  /** This node's name — used to filter out local routes from relay. */
  localNodeName: string
  /** DATA_CUSTODIAN JWT for relay authentication (RTSP sourcePass). */
  getRelayToken: () => string
  /** Known peer endpoint hosts, used for SSRF validation. */
  knownPeerHosts?: Set<string>
}

// ---------------------------------------------------------------------------
// SSRF validation
// ---------------------------------------------------------------------------

/**
 * Cloud metadata and link-local IPs that must never be used as relay sources.
 * A compromised peer could advertise these as stream endpoints to exfiltrate
 * cloud credentials or probe internal services.
 *
 * RFC 1918 ranges (10.x, 192.168.x) are intentionally NOT blocked — peers
 * typically run on private networks. The `knownPeerHosts` allowlist (when
 * configured) provides the defense against arbitrary private IP access.
 */
const BLOCKED_IPS = new Set([
  '169.254.169.254', // AWS/GCP/Azure metadata
  '::1', // IPv6 loopback
  '127.0.0.1', // IPv4 loopback
  '0.0.0.0', // wildcard
])

/**
 * Blocked IP prefixes — catches metadata ranges, link-local, and ULA.
 */
const BLOCKED_PREFIXES = [
  '169.254.', // AWS/GCP link-local metadata range
  'fe80:', // link-local IPv6
  'fd', // ULA (unique local address) range
]

export type SsrfResult =
  | { safe: true; host: string; port: number; path: string }
  | { safe: false; reason: string }

/**
 * Validate an endpoint URL for SSRF safety before using it as a relay source.
 * Returns the parsed host/port/path on success, or a rejection reason on failure.
 */
export function validateRelayEndpoint(endpoint: string, knownPeerHosts: Set<string>): SsrfResult {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return { safe: false, reason: `Invalid URL: ${endpoint}` }
  }

  // Scheme allowlist: only RTSP is valid for relay sources
  if (url.protocol !== 'rtsp:') {
    return { safe: false, reason: `Blocked scheme: ${url.protocol} (only rtsp: allowed)` }
  }

  // Strip brackets from IPv6 hostnames (URL parser keeps them for non-http schemes)
  const rawHost = url.hostname
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost

  // Direct IP blocklist
  if (BLOCKED_IPS.has(host)) {
    return { safe: false, reason: `Blocked IP: ${host}` }
  }

  // Prefix blocklist
  for (const prefix of BLOCKED_PREFIXES) {
    if (host.startsWith(prefix)) {
      return { safe: false, reason: `Blocked IP range: ${host}` }
    }
  }

  // If known peer hosts are configured, verify the host is a known peer
  if (knownPeerHosts.size > 0 && !knownPeerHosts.has(host)) {
    return { safe: false, reason: `Unknown host: ${host} (not a known peer)` }
  }

  const port = url.port ? parseInt(url.port, 10) : 8554
  const path = url.pathname.replace(/^\//, '')

  return { safe: true, host, port, path }
}

// ---------------------------------------------------------------------------
// Relay Manager
// ---------------------------------------------------------------------------

export class RelayManager {
  private readonly routeSource: RouteSubscription
  private readonly controlApi: ControlApiClient
  private readonly localNodeName: string
  private readonly getRelayToken: () => string
  private readonly knownPeerHosts: Set<string>

  /** Track active relay paths to support reconciliation and idempotency. */
  private readonly activeRelays = new Map<string, string>() // routeName → endpoint
  private unsubscribe: (() => void) | null = null

  constructor(options: RelayManagerOptions) {
    this.routeSource = options.routeSource
    this.controlApi = options.controlApi
    this.localNodeName = options.localNodeName
    this.getRelayToken = options.getRelayToken
    this.knownPeerHosts = options.knownPeerHosts ?? new Set()
  }

  /**
   * Start subscribing to route changes and managing relay paths.
   * Call this after the RPC connection is established.
   */
  async start(): Promise<void> {
    await this.reconcile()
    this.subscribe()
  }

  /**
   * Full reconciliation: fetch all routes, diff against active relays,
   * add missing paths and remove stale ones. Used on initial start and
   * after WebSocket reconnect.
   */
  async reconcile(): Promise<void> {
    const routes = await this.routeSource.listRoutes()

    // Build the desired state from internal routes
    const desired = new Map<string, InternalRoute>()
    for (const route of routes.internal) {
      if (route.protocol !== 'media') continue
      if (route.originNode === this.localNodeName) continue
      if (!route.endpoint) continue

      const validation = validateRelayEndpoint(route.endpoint, this.knownPeerHosts)
      if (!validation.safe) continue

      desired.set(route.name, route)
    }

    // Remove relays that are no longer in the route table
    for (const [name] of this.activeRelays) {
      if (!desired.has(name)) {
        await this.removeRelay(name)
      }
    }

    // Add relays that are missing
    for (const [name, route] of desired) {
      if (!this.activeRelays.has(name)) {
        await this.addRelay(name, route.endpoint!)
      }
    }
  }

  /**
   * Subscribe to route change deltas. Each change is processed incrementally.
   */
  private subscribe(): void {
    this.unsubscribe?.()
    this.unsubscribe = this.routeSource.watchRoutes((changes) => {
      for (const change of changes) {
        this.handleChange(change)
      }
    })
  }

  private handleChange(change: RouteChange): void {
    const route = change.route

    // Only handle media routes
    if (route.protocol !== 'media') return

    // Only handle remote routes (internal routes have originNode)
    if (!('originNode' in route)) return
    const internalRoute = route as InternalRoute
    if (internalRoute.originNode === this.localNodeName) return

    if (change.type === 'added' || change.type === 'updated') {
      if (!route.endpoint) return
      // Fire-and-forget: relay path creation is best-effort
      void this.addRelay(route.name, route.endpoint)
    } else if (change.type === 'removed') {
      void this.removeRelay(route.name)
    }
  }

  private async addRelay(name: string, endpoint: string): Promise<void> {
    const validation = validateRelayEndpoint(endpoint, this.knownPeerHosts)
    if (!validation.safe) return

    const relayToken = this.getRelayToken()
    const result = await this.controlApi.addPath(name, {
      source: endpoint,
      sourceOnDemand: true,
      sourceOnDemandStartTimeout: '10s',
      sourceOnDemandCloseAfter: '10s',
      // RTSP relay auth: RTSP has no Bearer header, so the DATA_CUSTODIAN
      // JWT is tunneled via sourcePass. The publishing node's auth hook
      // extracts the JWT from the password field for relay reads.
      sourceUser: 'relay',
      sourcePass: relayToken,
    })

    if (result.ok) {
      this.activeRelays.set(name, endpoint)
      logger.info('Relay path created for {streamPath} from {sourceNode}', {
        'event.name': 'video.relay.created',
        streamPath: name,
        sourceNode: validation.host,
        endpoint,
      })
    } else {
      logger.error('Failed to create relay path for {streamPath}: {error}', {
        'event.name': 'video.relay.create_failed',
        streamPath: name,
        endpoint,
        error: result.error,
      })
    }
  }

  private async removeRelay(name: string): Promise<void> {
    const result = await this.controlApi.deletePath(name)
    if (result.ok || result.status === 404) {
      this.activeRelays.delete(name)
      logger.info('Stale relay path removed: {streamPath}', {
        'event.name': 'video.relay.removed',
        streamPath: name,
      })
    }
  }

  /** Number of active relay paths. */
  get relayCount(): number {
    return this.activeRelays.size
  }

  /** Stop subscribing and clean up. Does NOT remove relay paths from MediaMTX. */
  shutdown(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}
