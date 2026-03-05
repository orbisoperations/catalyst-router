import type { DataChannelDefinition } from './datachannel.js'
import type { InternalRoute, RouteTable } from './state.js'

export type PortOperation =
  | { type: 'allocate'; routeKey: string }
  | { type: 'release'; routeKey: string; port: number }

export type RouteChange =
  | { type: 'added'; route: DataChannelDefinition | InternalRoute }
  | { type: 'removed'; route: DataChannelDefinition | InternalRoute }
  | { type: 'updated'; route: DataChannelDefinition | InternalRoute }

export type PlanResult = {
  prevState: RouteTable
  newState: RouteTable
  portOps: PortOperation[]
  routeChanges: RouteChange[]
}
