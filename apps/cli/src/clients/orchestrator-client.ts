import type { DataChannelDefinition, InternalRoute, PeerInfo, PeerRecord } from '@catalyst/routing'
import { newWebSocketRpcSession } from 'capnweb'
import { resolveServiceUrl } from './resolve-url.js'

// Polyfill Symbol.asyncDispose if necessary
// @ts-expect-error - polyfilling Symbol.asyncDispose
Symbol.asyncDispose ??= Symbol('Symbol.asyncDispose')

export type ActionResult = { success: true } | { success: false; error: string }

/**
 * Orchestrator PublicApi -- mirrors the actual orchestrator interface.
 */
export interface OrchestratorPublicApi {
  getNetworkClient(
    token: string
  ): Promise<{ success: true; client: NetworkClient } | { success: false; error: string }>
  getDataChannelClient(
    token: string
  ): Promise<{ success: true; client: DataChannel } | { success: false; error: string }>
  getIBGPClient(
    token: string
  ): Promise<{ success: true; client: IBGPClient } | { success: false; error: string }>
}

export interface NetworkClient {
  addPeer(peer: PeerInfo): Promise<ActionResult>
  updatePeer(peer: PeerInfo): Promise<ActionResult>
  removePeer(peer: Pick<PeerInfo, 'name'>): Promise<ActionResult>
  listPeers(): Promise<PeerRecord[]>
}

export interface DataChannel {
  addRoute(route: DataChannelDefinition): Promise<ActionResult>
  removeRoute(route: DataChannelDefinition): Promise<ActionResult>
  listRoutes(): Promise<{
    local: DataChannelDefinition[]
    internal: InternalRoute[]
  }>
}

export interface IBGPClient {
  open(peer: PeerInfo): Promise<ActionResult>
  close(peer: PeerInfo, code: number, reason?: string): Promise<ActionResult>
  update(peer: PeerInfo, update: unknown): Promise<ActionResult>
}

export async function createOrchestratorClient(url?: string): Promise<OrchestratorPublicApi> {
  const resolved = resolveServiceUrl({
    url,
    envVar: 'CATALYST_ORCHESTRATOR_URL',
    defaultPort: 3000,
  })
  return newWebSocketRpcSession<OrchestratorPublicApi>(resolved)
}
