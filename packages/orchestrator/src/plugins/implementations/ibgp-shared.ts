/**
 * Shared utilities for iBGP plugin handlers.
 * Contains common dependencies and helper functions.
 */

import { getConfig } from '../../config.js'
import type { getHttpPeerSession } from '../../rpc/client.js'
import type { PeerInfo } from '../../rpc/schema/peering.js'
import type { PluginContext, PluginResult } from '../types.js'
import type { RouteTable } from '../../state/route-table.js'

export type SessionFactory = typeof getHttpPeerSession

/** Get the local peer info from configuration. */
export function getMyPeerInfo(): PeerInfo {
  const config = getConfig()
  return {
    id: config.ibgp.localId || 'unknown',
    as: config.as,
    domains: config.ibgp.domains,
    endpoint: config.ibgp.endpoint || 'unknown',
  }
}

/** Create a parse error result. */
export function parseError(
  pluginName: string,
  message: string,
  ctx: PluginContext,
  error?: any
): PluginResult {
  return { success: false, ctx, error: { pluginName, message, error } }
}

/** Build route update messages from current state. */
export function buildRouteUpdates(
  state: RouteTable
): { type: 'add'; route: any; asPath: number[] }[] {
  const config = getConfig()
  return state.getAllRoutes().map((route) => ({
    type: 'add' as const,
    route: route.service,
    asPath: [config.as, ...(route.asPath || [])],
  }))
}
