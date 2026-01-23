import type { RpcPromise, RpcStub } from 'capnweb'
import { newWebSocketRpcSession } from 'capnweb'
import type {
  ListLocalRoutesResult,
  ApplyActionResult,
} from '../../orchestrator/src/rpc/schema/index.js'
import type { ListPeersResult } from '../../orchestrator/src/rpc/schema/peering.js'

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
