import type { AuthorizationDomain, AuthorizationEngine } from '@catalyst/authorization'
import { Action, Role } from '@catalyst/authorization'

export type IBGPEntity = {
  name: string
  status: 'connected' | 'disconnected'
  connectedAt: string
  disconnectedAt?: string
  lastUpdate: string
  lastUpdateReason?: string
  lastUpdateCode?: number
  lastUpdateMessage?: string
  lastUpdateError?: string
}

export type PeerEntity = {
  name: string
  status: 'connected' | 'disconnected'
  connectedAt: string
  disconnectedAt?: string
  lastUpdate: string
  lastUpdateReason?: string
  lastUpdateCode?: number
  lastUpdateMessage?: string
  lastUpdateError?: string
}

export type RouteEntity = {
  name: string
  protocol: 'http' | 'http:graphql' | 'http:gql' | 'http:grpc'
  endpoint?: string | undefined
  region?: string | undefined
  tags?: string[] | undefined
}

/**
 * Catalyst Policy Domain definition.
 * Aligns Cedar roles and actions with TypeScript types.
 */
export interface CatalystPolicyDomain extends AuthorizationDomain {
  Actions: Action
  Entities: {
    [Role.ADMIN]: Record<string, unknown>
    [Role.NODE]: Record<string, unknown>
    [Role.DATA_CUSTODIAN]: Record<string, unknown>
    [Role.NODE_CUSTODIAN]: Record<string, unknown>
    [Role.USER]: Record<string, unknown>
    IBGP: IBGPEntity
    Peer: PeerEntity
    Route: RouteEntity
    Token: Record<string, unknown>
    AdminPanel: Record<string, unknown>
  }
}

export type CatalystPolicyEngine = AuthorizationEngine<CatalystPolicyDomain>
