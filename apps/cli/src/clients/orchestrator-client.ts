import { newWebSocketRpcSession } from 'capnweb'
import { resolveServiceUrl } from './resolve-url.js'
import type { PeerInfo, PeerRecord, DataChannelDefinition, InternalRoute } from '@catalyst/routing'

// Polyfill Symbol.asyncDispose if necessary
// @ts-expect-error - polyfilling Symbol.asyncDispose
Symbol.asyncDispose ??= Symbol('Symbol.asyncDispose')

export type ActionResult = { success: true } | { success: false; error: string }

/**
 * Data channel client — manages local and internal routes.
 *
 * Matches the server-side `DataChannel` interface from the orchestrator's
 * `publicApi().getDataChannelClient(token)` progressive RPC pattern.
 */
export interface DataChannelClient {
  addRoute(route: DataChannelDefinition): Promise<ActionResult>
  removeRoute(route: DataChannelDefinition): Promise<ActionResult>
  listRoutes(): Promise<{ local: DataChannelDefinition[]; internal: InternalRoute[] }>
}

/**
 * Network client — manages peer connections.
 *
 * Matches the server-side `NetworkClient` interface from the orchestrator's
 * `publicApi().getNetworkClient(token)` progressive RPC pattern.
 */
export interface NetworkClient {
  addPeer(peer: PeerInfo): Promise<ActionResult>
  updatePeer(peer: PeerInfo): Promise<ActionResult>
  removePeer(peer: Pick<PeerInfo, 'name'>): Promise<ActionResult>
  listPeers(): Promise<PeerRecord[]>
}

/**
 * Orchestrator public API — progressive RPC pattern.
 *
 * Each method authenticates with a token and returns a scoped client
 * for a specific domain (data channels, networking, etc.).
 */
export interface OrchestratorPublicApi {
  getDataChannelClient(
    token: string
  ): Promise<{ success: true; client: DataChannelClient } | { success: false; error: string }>
  getNetworkClient(
    token: string
  ): Promise<{ success: true; client: NetworkClient } | { success: false; error: string }>
}

export async function createOrchestratorClient(url?: string): Promise<OrchestratorPublicApi> {
  const resolved = resolveServiceUrl({
    url,
    envVar: 'CATALYST_ORCHESTRATOR_URL',
    defaultPort: 3000,
  })
  return newWebSocketRpcSession<OrchestratorPublicApi>(resolved)
}
