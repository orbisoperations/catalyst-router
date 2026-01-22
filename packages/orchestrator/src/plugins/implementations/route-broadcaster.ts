/**
 * RouteBroadcaster - Handles outbound route propagation to iBGP peers.
 *
 * DECOUPLED ARCHITECTURE: Subscribes to route events from eventBus instead of
 * intercepting actions in the plugin pipeline. This ensures:
 * 1. No coupling to LocalRouting's action schema
 * 2. Broadcasts happen AFTER state is committed (fresh data)
 * 3. Clean separation of concerns
 */

import { getConfig } from '../../config.js'
import { withTimeout, getRpcTimeout } from '../../utils/timeout.js'
import type { SessionFactory } from './ibgp-shared.js'
import { getMyPeerInfo } from './ibgp-shared.js'
import { getHttpPeerSession } from '../../rpc/client.js'
import type { RouteEvent } from '../../events/index.js'
import { eventBus } from '../../events/index.js'
import type { RouteTable } from '../../state/route-table.js'
import type { AuthorizedPeer, UpdateMessage } from '../../rpc/schema/peering.js'

export type StateProvider = () => RouteTable
type RouteEventHandler = (event: RouteEvent) => void

export class RouteBroadcaster {
  private readonly name = 'RouteBroadcaster'
  private isSubscribed = false
  private boundHandler?: RouteEventHandler

  constructor(
    private readonly stateProvider: StateProvider,
    private readonly sessionFactory: SessionFactory = getHttpPeerSession
  ) {}

  /**
   * Start listening for route events and broadcasting to peers.
   * Call this once after the server is initialized.
   */
  start(): void {
    if (this.isSubscribed) return

    // Store handler reference for proper cleanup in stop()
    this.boundHandler = (event: RouteEvent) => {
      // Only broadcast local route changes, not routes received from peers
      if (event.source === 'local') {
        this.handleRouteEvent(event)
      }
    }

    eventBus.onAllRouteEvents(this.boundHandler)
    this.isSubscribed = true
    console.log(`[${this.name}] Subscribed to route events`)
  }

  /**
   * Stop listening for route events.
   * Properly unsubscribes the handler to prevent memory leaks.
   */
  stop(): void {
    if (this.boundHandler) {
      eventBus.offAllRouteEvents(this.boundHandler)
      this.boundHandler = undefined
    }
    this.isSubscribed = false
    console.log(`[${this.name}] Unsubscribed from route events`)
  }

  private handleRouteEvent(event: RouteEvent): void {
    const updateMsg = this.buildUpdateMessage(event)
    if (!updateMsg) return

    // Get current state for peer list
    const state = this.stateProvider()
    const peers = state.getPeers()

    console.log(`[${this.name}] Broadcasting ${event.type} to ${peers.length} peers`)

    // Fire and forget with explicit error boundary
    this.broadcastToAllPeers(peers, updateMsg).catch((err) => {
      console.error(`[${this.name}] Unexpected broadcast error:`, err)
    })
  }

  private buildUpdateMessage(event: RouteEvent): UpdateMessage | null {
    const config = getConfig()

    if (event.type === 'route:created' || event.type === 'route:updated') {
      return {
        type: 'add',
        route: {
          name: event.route.name,
          protocol: event.route.protocol,
          endpoint: event.route.endpoint,
          region: event.route.region,
        },
        asPath: [config.as],
      }
    } else if (event.type === 'route:deleted') {
      return {
        type: 'remove',
        routeId: event.route.id,
      }
    }

    return null
  }

  private async broadcastToAllPeers(peers: AuthorizedPeer[], msg: UpdateMessage): Promise<void> {
    const results = await Promise.all(peers.map((p) => this.sendUpdateToPeer(p, msg)))

    const failures = results.filter((r) => !r.success)
    if (failures.length > 0) {
      console.warn(`[${this.name}] ${failures.length}/${peers.length} broadcasts failed`)
    }
  }

  private async sendUpdateToPeer(
    peer: AuthorizedPeer,
    msg: UpdateMessage
  ): Promise<{ success: boolean; error?: string }> {
    if (!peer.endpoint || peer.endpoint === 'unknown') {
      return { success: true } // Skip peers without valid endpoints
    }

    try {
      const config = getConfig()
      const ibgpScope = this.sessionFactory(peer.endpoint, config.ibgp.secret)
      await withTimeout(
        ibgpScope.update(getMyPeerInfo(), [msg]),
        getRpcTimeout(),
        `UPDATE to ${peer.endpoint}`
      )
      return { success: true }
    } catch (e: any) {
      console.error(`[${this.name}] Failed update to ${peer.id}:`, e.message)
      return { success: false, error: e.message }
    }
  }
}
