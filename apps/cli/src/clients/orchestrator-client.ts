import type { RpcStub } from 'capnweb'
import { newWebSocketRpcSession } from 'capnweb'
import type { PeerInfo, DataChannelDefinition, InternalRoute } from '@catalyst/routing'

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

export async function createOrchestratorClient(
  url: string = process.env.CATALYST_ORCHESTRATOR_URL || 'ws://localhost:3000/rpc'
): Promise<OrchestratorPublicApi> {
  return newWebSocketRpcSession<OrchestratorPublicApi>(url)
}
