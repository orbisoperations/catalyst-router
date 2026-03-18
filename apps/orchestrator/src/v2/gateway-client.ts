import { newHttpBatchRpcSession, type RpcStub } from 'capnweb'
import type { GatewayClient, GatewayUpdateResult } from './bus.js'

interface GatewayRpcApi {
  updateConfig(config: {
    services: Array<{ name: string; url: string }>
  }): Promise<GatewayUpdateResult>
}

/**
 * capnweb-backed gateway client.
 * Uses HTTP batch RPC to call the gateway's `updateConfig` method.
 * The stub is created lazily on first use and reused for subsequent calls.
 */
export function createGatewayClient(endpoint: string): GatewayClient {
  let stub: RpcStub<GatewayRpcApi> | undefined

  return {
    async updateConfig(config) {
      if (stub === undefined) {
        stub = newHttpBatchRpcSession<GatewayRpcApi>(endpoint)
      }
      return stub.updateConfig(config)
    },
  }
}
