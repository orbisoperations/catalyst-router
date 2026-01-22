import { RpcTarget } from 'capnweb'
import { type Action } from './schema.js'
import type { PeerInfo } from './routing/state.js'
import { newRouteTable, type RouteTable } from './routing/state.js'
import {
  newHttpBatchRpcSession,
  newWebSocketRpcSession,
  type RpcCompatible,
  type RpcStub,
} from 'capnweb'
// Interface for classes that need to emit actions
export interface PublicApi {
  getManagerConnection(): PeerManager
  getPeerConnection(
    secret: string
  ): { success: true; connection: PeerConnection } | { success: false; error: string }
}

export interface PeerManager {
  addPeer(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
  updatePeer(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
  removePeer(
    peer: Pick<PeerInfo, 'name'>
  ): Promise<{ success: true } | { success: false; error: string }>
}

export interface PeerConnection {
  open(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
}

export function getHttpPeerSession<API extends RpcCompatible<API>>(endpoint: string) {
  return newHttpBatchRpcSession<API>(endpoint)
}

export function getWebSocketPeerSession<API extends RpcCompatible<API>>(endpoint: string) {
  return newWebSocketRpcSession<API>(endpoint)
}

class ConnectionPool {
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
}

export class CatalystNodeBus extends RpcTarget {
  private state: RouteTable
  private connectionPool: ConnectionPool
  constructor(opts: {
    state?: RouteTable
    connectionPool?: { type?: 'ws' | 'http'; pool?: ConnectionPool }
  }) {
    super()
    this.state = opts.state ?? newRouteTable()
    this.connectionPool =
      (opts.connectionPool?.pool ?? opts.connectionPool?.type)
        ? new ConnectionPool(opts.connectionPool.type)
        : new ConnectionPool()
  }

  async dispatch(
    sentAction: Action
  ): Promise<{ success: true } | { success: false; error: string }> {
    const result = await this.handleAction(sentAction, this.state)
    if (result.success) {
      this.state = result.state
      return { success: true }
    }
    return result
  }

  async handleAction(
    action: Action,
    state: RouteTable
  ): Promise<{ success: true; state: RouteTable } | { success: false; error: string }> {
    switch (action.action) {
      case 'local:peer:create': {
        const peerList = state.internal.peers
        if (peerList.find((p) => p.name === action.data.peerInfo.name)) {
          return { success: false, error: 'Peer already exists' }
        }
        state = {
          ...state,
          internal: {
            routes: state.internal.routes,
            peers: [
              ...state.internal.peers,
              {
                name: action.data.peerInfo.name,
                endpoint: action.data.peerInfo.endpoint,
                domains: action.data.peerInfo.domains,
                connectionStatus: 'initializing',
                lastConnected: undefined,
              },
            ],
          },
        }
        break
      }
      case 'local:peer:update': {
        const peerList = state.internal.peers
        const peer = peerList.find((p) => p.name === action.data.peerInfo.name)
        if (!peer) {
          return { success: false, error: 'Peer not found' }
        }
        state = {
          ...state,
          internal: {
            routes: state.internal.routes,
            peers: peerList.map((p) =>
              p.name === action.data.peerInfo.name
                ? {
                    ...p,
                    endpoint: action.data.peerInfo.endpoint,
                    domains: action.data.peerInfo.domains,
                    connectionStatus: 'initializing',
                    lastConnected: undefined,
                  }
                : p
            ),
          },
        }
        break
      }
      case 'local:peer:delete': {
        const peerList = state.internal.peers
        const peer = peerList.find((p) => p.name === action.data.peerInfo.name)
        if (!peer) {
          return { success: false, error: 'Peer not found' }
        }
        state = {
          ...state,
          internal: {
            routes: state.internal.routes,
            peers: peerList.filter((p) => p.name !== action.data.peerInfo.name),
          },
        }
        break
      }
      default: {
        console.log('Unknown action', action)
        break
      }
    }

    return { success: true, state }
  }

  publicApi(): PublicApi {
    return {
      getManagerConnection: (): PeerManager => {
        return {
          addPeer: async (peer: PeerInfo) => {
            console.log('addPeer', peer)
            return this.dispatch({
              action: 'local:peer:create',
              data: { peerInfo: peer },
            })
          },
          updatePeer: async (peer: PeerInfo) => {
            console.log('updatePeer', peer)
            return this.dispatch({
              action: 'local:peer:update',
              data: { peerInfo: peer },
            })
          },
          removePeer: async (peer: Omit<PeerInfo, 'endpoint' | 'domains'>) => {
            console.log('removePeer', peer)
            return this.dispatch({
              action: 'local:peer:delete',
              data: { peerInfo: peer },
            })
          },
        }
      },
      getPeerConnection: (
        _secret: string
      ): { success: true; connection: PeerConnection } | { success: false; error: string } => {
        return { success: false, error: 'Not implemented' }
      },
    }
  }
}
