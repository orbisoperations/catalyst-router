import type { DataChannelDefinition } from './datachannel.js'
import { z } from 'zod'

import { NodeConfigSchema } from '@catalyst/config'

export const PeerInfoSchema = NodeConfigSchema

export type PeerInfo = z.infer<typeof PeerInfoSchema>

export const PeerConnectionStatusEnum = z.enum([
  'initializing',
  'connected',
  'degraded',
  'closed',
] as const)
export type PeerConnectionStatus = z.infer<typeof PeerConnectionStatusEnum>

export const PeerRecordSchema = PeerInfoSchema.extend({
  connectionStatus: PeerConnectionStatusEnum,
  lastConnected: z.date().optional(),
  lastMessageReceived: z.date().optional(),
  holdTime: z.number().optional(),
})

export type PeerRecord = z.infer<typeof PeerRecordSchema>

export type InternalRoute = DataChannelDefinition & {
  peer: PeerInfo
  peerName: string
  nodePath: string[]
}

export type RouteTable = {
  local: {
    routes: DataChannelDefinition[]
  }
  internal: {
    peers: PeerRecord[]
    routes: InternalRoute[]
  }
  external: {
    // Placeholder for future extensibility
    [key: string]: unknown
  }
}

export function newRouteTable(): RouteTable {
  return {
    local: {
      routes: [],
    },
    internal: {
      peers: [],
      routes: [],
    },
    external: {},
  }
}
