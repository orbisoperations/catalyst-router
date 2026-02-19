import type { z } from 'zod'
import type {
  Action,
  DataChannelDefinition,
  InternalRoute,
  PeerInfo,
  PeerRecord,
  UpdateMessageSchema,
} from '@catalyst/routing'

// Centralized UpdateMessage type — consumers import this instead of z.infer
export type UpdateMessage = z.infer<typeof UpdateMessageSchema>

export interface PublicApi {
  getNetworkClient(
    token: string
  ): Promise<{ success: true; client: NetworkClient } | { success: false; error: string }>
  getDataChannelClient(
    token: string
  ): Promise<{ success: true; client: DataChannel } | { success: false; error: string }>
  getIBGPClient(
    token: string
  ): Promise<{ success: true; client: IBGPClient } | { success: false; error: string }>
  dispatch(action: Action): Promise<{ success: true } | { success: false; error: string }>
}

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
    route: DataChannelDefinition
  ): Promise<{ success: true } | { success: false; error: string }>
  listRoutes(): Promise<{ local: DataChannelDefinition[]; internal: InternalRoute[] }>
}

export interface IBGPClient {
  open(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
  close(
    peer: PeerInfo,
    code: number,
    reason?: string
  ): Promise<{ success: true } | { success: false; error: string }>
  update(
    peer: PeerInfo,
    update: UpdateMessage
  ): Promise<{ success: true } | { success: false; error: string }>
}

export interface EnvoyApi {
  updateRoutes(config: {
    local: DataChannelDefinition[]
    internal: InternalRoute[]
    portAllocations: Record<string, number>
  }): Promise<{ success: true } | { success: false; error: string }>
}

export interface GatewayApi {
  updateConfig(config: {
    services: Array<{ name: string; url: string }>
  }): Promise<{ success: true } | { success: false; error: string }>
}

export type Propagation =
  | { type: 'update'; peer: PeerRecord; localNode: PeerInfo; update: UpdateMessage }
  | { type: 'open'; peer: PeerRecord; localNode: PeerInfo }
  | { type: 'close'; peer: PeerRecord; localNode: PeerInfo; code: number; reason?: string }
