import type { RpcStub } from 'capnweb'
import { newWebSocketRpcSession } from 'capnweb'
import { resolveServiceUrl } from './resolve-url.js'
import type { PeerInfo } from '@catalyst/orchestrator'
import type { DataChannelDefinition } from '@catalyst/orchestrator'
import type { InternalRoute } from '@catalyst/orchestrator'

// Polyfill Symbol.asyncDispose if necessary
// @ts-expect-error - polyfilling Symbol.asyncDispose
Symbol.asyncDispose ??= Symbol('Symbol.asyncDispose')

export type ActionResult = { success: true } | { success: false; error: string }

export interface OrchestratorPublicApi {
  connectionFromManagementSDK(): RpcStub<ManagementScope>
}

export interface ManagementScope {
  applyAction(action: unknown): Promise<ActionResult>
  listLocalRoutes(): Promise<{
    routes: { local: DataChannelDefinition[]; internal: InternalRoute[] }
  }>
  listMetrics(): Promise<unknown>
  listPeers(): Promise<{ peers: PeerInfo[] }>
  deletePeer(peerId: string): Promise<ActionResult>
}

export async function createOrchestratorClient(url?: string): Promise<OrchestratorPublicApi> {
  const resolved = resolveServiceUrl({
    url,
    envVar: 'CATALYST_ORCHESTRATOR_URL',
    defaultPort: 3000,
  })
  return newWebSocketRpcSession<OrchestratorPublicApi>(resolved)
}
