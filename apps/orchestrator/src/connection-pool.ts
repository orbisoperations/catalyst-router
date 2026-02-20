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
  private envoyStubs: Map<string, RpcStub<EnvoyApi>>
  private gatewayStubs: Map<string, RpcStub<GatewayApi>>

  constructor(private type: 'ws' | 'http' = 'http') {
    this.stubs = new Map<string, RpcStub<PublicApi>>()
    this.envoyStubs = new Map<string, RpcStub<EnvoyApi>>()
    this.gatewayStubs = new Map<string, RpcStub<GatewayApi>>()
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
    const cached = this.envoyStubs.get(endpoint)
    if (cached) return cached
    const stub =
      this.type === 'ws'
        ? newWebSocketRpcSession<EnvoyApi>(endpoint)
        : newHttpBatchRpcSession<EnvoyApi>(endpoint)
    this.envoyStubs.set(endpoint, stub)
    return stub
  }

  getGateway(endpoint: string): RpcStub<GatewayApi> {
    const cached = this.gatewayStubs.get(endpoint)
    if (cached) return cached
    const stub =
      this.type === 'ws'
        ? newWebSocketRpcSession<GatewayApi>(endpoint)
        : newHttpBatchRpcSession<GatewayApi>(endpoint)
    this.gatewayStubs.set(endpoint, stub)
    return stub
  }
}
