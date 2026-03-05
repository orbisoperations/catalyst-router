import { Actions } from '@catalyst/routing/v2'
import type {
  PeerInfo,
  PeerRecord,
  DataChannelDefinition,
  InternalRoute,
  UpdateMessageSchema,
} from '@catalyst/routing/v2'
import type { z } from 'zod'
import type { OrchestratorBus } from './bus.js'

// ---------------------------------------------------------------------------
// RPC interface definitions — match v1 shapes for backward compatibility,
// with v2 additions (keepalive on IBGPClient).
// ---------------------------------------------------------------------------

export interface NetworkClient {
  addPeer(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
  updatePeer(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
  removePeer(
    peer: Pick<PeerInfo, 'name'>
  ): Promise<{ success: true } | { success: false; error: string }>
  listPeers(): Promise<PeerRecord[]>
}

export interface DataChannel {
  addRoute(
    route: DataChannelDefinition
  ): Promise<{ success: true } | { success: false; error: string }>
  removeRoute(
    route: Pick<DataChannelDefinition, 'name'>
  ): Promise<{ success: true } | { success: false; error: string }>
  listRoutes(): Promise<{ local: DataChannelDefinition[]; internal: InternalRoute[] }>
}

export interface IBGPClient {
  open(data: {
    peerInfo: PeerInfo
    holdTime?: number
  }): Promise<{ success: true } | { success: false; error: string }>
  close(data: {
    peerInfo: PeerInfo
    code: number
    reason?: string
  }): Promise<{ success: true } | { success: false; error: string }>
  update(data: {
    peerInfo: PeerInfo
    update: z.infer<typeof UpdateMessageSchema>
  }): Promise<{ success: true } | { success: false; error: string }>
  keepalive(data: {
    peerInfo: PeerInfo
  }): Promise<{ success: true } | { success: false; error: string }>
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function createNetworkClient(bus: OrchestratorBus): NetworkClient {
  return {
    async addPeer(peer) {
      const result = await bus.dispatch({ action: Actions.LocalPeerCreate, data: peer })
      return result.success ? { success: true } : { success: false, error: result.error }
    },

    async updatePeer(peer) {
      const result = await bus.dispatch({ action: Actions.LocalPeerUpdate, data: peer })
      return result.success ? { success: true } : { success: false, error: result.error }
    },

    async removePeer(peer) {
      const result = await bus.dispatch({
        action: Actions.LocalPeerDelete,
        data: peer as Pick<PeerInfo, 'name'>,
      })
      return result.success ? { success: true } : { success: false, error: result.error }
    },

    async listPeers() {
      return bus.state.internal.peers.map(({ peerToken: _, ...rest }) => rest)
    },
  }
}

export function createDataChannelClient(bus: OrchestratorBus): DataChannel {
  return {
    async addRoute(route) {
      const result = await bus.dispatch({ action: Actions.LocalRouteCreate, data: route })
      return result.success ? { success: true } : { success: false, error: result.error }
    },

    async removeRoute(route) {
      const result = await bus.dispatch({
        action: Actions.LocalRouteDelete,
        data: route as DataChannelDefinition,
      })
      return result.success ? { success: true } : { success: false, error: result.error }
    },

    async listRoutes() {
      return {
        local: bus.state.local.routes,
        internal: bus.state.internal.routes.map((r) => {
          const { peerToken: _, ...safePeer } = r.peer
          return { ...r, peer: safePeer }
        }),
      }
    },
  }
}

export function createIBGPClient(bus: OrchestratorBus): IBGPClient {
  return {
    async open(data) {
      const result = await bus.dispatch({ action: Actions.InternalProtocolOpen, data })
      return result.success ? { success: true } : { success: false, error: result.error }
    },

    async close(data) {
      const result = await bus.dispatch({ action: Actions.InternalProtocolClose, data })
      return result.success ? { success: true } : { success: false, error: result.error }
    },

    async update(data) {
      const result = await bus.dispatch({ action: Actions.InternalProtocolUpdate, data })
      return result.success ? { success: true } : { success: false, error: result.error }
    },

    async keepalive(data) {
      const result = await bus.dispatch({ action: Actions.InternalProtocolKeepalive, data })
      return result.success ? { success: true } : { success: false, error: result.error }
    },
  }
}
