import { newWebSocketRpcSession, type RpcStub } from 'capnweb'
import type { EnvoyClient, EnvoyUpdateResult } from './bus.js'

interface EnvoyRpcApi {
  updateRoutes(config: {
    local: Array<{ name: string; protocol: string; endpoint?: string; envoyPort?: number }>
    internal: Array<{
      name: string
      protocol: string
      endpoint?: string
      envoyPort?: number
      peer: { name: string; envoyAddress?: string }
      nodePath: string[]
    }>
    portAllocations?: Record<string, number>
  }): Promise<EnvoyUpdateResult>
}

/**
 * capnweb-backed envoy client.
 * Uses HTTP batch RPC to call the envoy service's `updateRoutes` method.
 * The stub is created lazily on first use and reused for subsequent calls.
 */
export function createEnvoyClient(endpoint: string): EnvoyClient {
  let stub: RpcStub<EnvoyRpcApi> | undefined

  return {
    async updateRoutes(config) {
      if (stub === undefined) {
        stub = newWebSocketRpcSession<EnvoyRpcApi>(endpoint)
      }
      return stub.updateRoutes(config)
    },
  }
}
