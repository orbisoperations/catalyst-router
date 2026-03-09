import type { DataChannelDefinition } from './datachannel.js'
import { z } from 'zod'
import { NodeConfigSchema } from '@catalyst/config'

export const PeerInfoSchema = NodeConfigSchema
export type PeerInfo = z.infer<typeof PeerInfoSchema>

export const PeerConnectionStatusEnum = z.enum(['initializing', 'connected', 'closed'] as const)
export type PeerConnectionStatus = z.infer<typeof PeerConnectionStatusEnum>

export const PeerRecordSchema = PeerInfoSchema.extend({
  connectionStatus: PeerConnectionStatusEnum,
  lastConnected: z.date().optional(),
  holdTime: z.number().default(90_000),
  lastSent: z.number().default(0),
  lastReceived: z.number().default(0),
})
export type PeerRecord = z.infer<typeof PeerRecordSchema>

export type InternalRoute = DataChannelDefinition & {
  peer: PeerInfo
  nodePath: string[]
  originNode: string
  isStale?: boolean
}

export type LocRibEntry = {
  route: InternalRoute
  alternatives: InternalRoute[]
  isStale: boolean
}

export type RouteTable = {
  local: {
    routes: DataChannelDefinition[]
  }
  internal: {
    peers: PeerRecord[]
    routes: InternalRoute[]
  }
}

export function newRouteTable(): RouteTable {
  return {
    local: { routes: [] },
    internal: { peers: [], routes: [] },
  }
}
