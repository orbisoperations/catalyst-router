import type { AuthorizationDomain, AuthorizationEngine } from '@catalyst/authorization'
import type { User as UserEntity } from '../models'

/***
 *
 * TODO:
 * - Add the missing entities and actions to the domain.
 *
 * NOTE: This is a temporary type definition for the Catalyst Policy Domain.
 * It is not final and will be replaced with a more permanent solution in the future.
 *
 * We need to centralize the Data Models in one place. We could import them from the orchestrator
 * package or elsewhere. Currently this entities below duplicate/replicating the values in orchestrator package.
 *
 *
 */

export type { UserEntity }

export type RoleEntity = {
  name: string
}

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

// Domain
export interface CatalystPolicyDomain extends AuthorizationDomain {
  Actions: 'login' | 'open' | 'close' | 'update' | 'create' | 'delete' | 'list' | 'view' | 'revoke'
  Entities: {
    User: UserEntity
    Role: RoleEntity
    IBGP: IBGPEntity
    Peer: PeerEntity
    Route: RouteEntity
    AdminPanel: Record<string, unknown>
  }
}

export type CatalystPolicyEngine = AuthorizationEngine<CatalystPolicyDomain>
