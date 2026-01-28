import type { RpcPromise, RpcStub } from 'capnweb'
import { newWebSocketRpcSession } from 'capnweb'
import type { PeerInfo } from '../../orchestrator/src/orchestrator.js'
import type { DataChannelDefinition } from '../../orchestrator/src/routing/datachannel.js'
import type { InternalRoute } from '../../orchestrator/src/routing/state.js'

export type ApplyActionResult = { success: true } | { success: false; error: string }
export type ListLocalRoutesResult = {
  routes: { local: DataChannelDefinition[]; internal: InternalRoute[] }
}
export type ListPeersResult = { peers: PeerInfo[] }

// Polyfill Symbol.asyncDispose if necessary (TypeScript < 5.2 or older environments)
// @ts-expect-error - polyfilling Symbol.asyncDispose
Symbol.asyncDispose ??= Symbol('Symbol.asyncDispose')

export async function createClient(
  url: string = process.env.CATALYST_ORCHESTRATOR_URL || 'ws://localhost:4015/rpc'
): Promise<PublicApi> {
  const clientStub = newWebSocketRpcSession<PublicApi>(url)

  return clientStub as unknown as PublicApi
}

export type RpcClient = RpcPromise<PublicApi>

export interface PublicApi {
  connectionFromManagementSDK(): RpcStub<ManagementScope>
}

export interface ManagementScope {
  applyAction(action: unknown): Promise<ApplyActionResult>
  listLocalRoutes(): Promise<ListLocalRoutesResult>
  listMetrics(): Promise<unknown>
  listPeers(): Promise<ListPeersResult>
  deletePeer(peerId: string): Promise<ApplyActionResult>
}
