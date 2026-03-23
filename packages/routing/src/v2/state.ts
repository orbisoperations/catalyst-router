import type { DataChannelDefinition } from './datachannel.js'
import { routeKey } from './datachannel.js'
import { z } from 'zod'
import { NodeConfigSchema } from '@catalyst/config'

export const PeerInfoSchema = NodeConfigSchema
export type PeerInfo = z.infer<typeof PeerInfoSchema>

export const PeerConnectionStatusEnum = z.enum(['initializing', 'connected', 'closed'] as const)
export type PeerConnectionStatus = z.infer<typeof PeerConnectionStatusEnum>

export const PeerRecordSchema = PeerInfoSchema.extend({
  connectionStatus: PeerConnectionStatusEnum,
  lastConnected: z.number().default(0),
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

export type RouteTable = {
  local: {
    routes: Map<string, DataChannelDefinition>
  }
  internal: {
    peers: Map<string, PeerRecord>
    routes: Map<string, Map<string, InternalRoute>>
  }
}

export function newRouteTable(): RouteTable {
  return {
    local: { routes: new Map() },
    internal: { peers: new Map(), routes: new Map() },
  }
}

/** Composite key for internal routes in the nested Map. */
export function internalRouteKey(route: Pick<InternalRoute, 'name' | 'originNode'>): string {
  return `${routeKey(route)}:${route.originNode}`
}
