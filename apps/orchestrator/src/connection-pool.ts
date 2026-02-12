import {
  newHttpBatchRpcSession,
  newWebSocketRpcSession,
  type RpcCompatible,
  type RpcStub,
} from 'capnweb'
import type { PublicApi, EnvoyApi, GatewayApi } from './api-types.js'

export function getHttpPeerSession<API extends RpcCompatible<API>>(endpoint: string) {
  return newHttpBatchRpcSession<API>(endpoint)
}

export function getWebSocketPeerSession<API extends RpcCompatible<API>>(endpoint: string) {
  return newWebSocketRpcSession<API>(endpoint)
}

export class ConnectionPool {
  private stubs: Map<string, RpcStub<PublicApi>>
  constructor(private type: 'ws' | 'http' = 'http') {
    this.stubs = new Map<string, RpcStub<PublicApi>>()
  }

  get(endpoint: string) {
    if (this.stubs.has(endpoint)) {
      return this.stubs.get(endpoint)
    }
    switch (this.type) {
      case 'http': {
        const stub = newHttpBatchRpcSession<PublicApi>(endpoint)
        this.stubs.set(endpoint, stub)
        return stub
      }
      case 'ws': {
        const stub = newWebSocketRpcSession<PublicApi>(endpoint)
        this.stubs.set(endpoint, stub)
        return stub
      }
    }
  }

  getEnvoy(endpoint: string): RpcStub<EnvoyApi> {
    return this.type === 'ws'
      ? newWebSocketRpcSession<EnvoyApi>(endpoint)
      : newHttpBatchRpcSession<EnvoyApi>(endpoint)
  }

  getGateway(endpoint: string): RpcStub<GatewayApi> {
    return this.type === 'ws'
      ? newWebSocketRpcSession<GatewayApi>(endpoint)
      : newHttpBatchRpcSession<GatewayApi>(endpoint)
  }
}
