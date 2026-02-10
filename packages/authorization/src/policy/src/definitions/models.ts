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
 * Standardized roles for the Catalyst system.
 * These serve as primary Principal Types in Cedar.
 */
export enum Role {
  ADMIN = 'ADMIN',
  NODE = 'NODE',
  NODE_CUSTODIAN = 'NODE_CUSTODIAN',
  DATA_CUSTODIAN = 'DATA_CUSTODIAN',
  USER = 'USER',
  TELEMETRY_EXPORTER = 'TELEMETRY_EXPORTER',
}

/**
 * Cedar principal types for the Catalyst system.
 * These are the actual entity type strings used in Cedar policies.
 * Tokens store the principal directly — no role-to-principal mapping needed at verification time.
 */
export enum Principal {
  ADMIN = 'CATALYST::ADMIN',
  NODE = 'CATALYST::NODE',
  NODE_CUSTODIAN = 'CATALYST::NODE_CUSTODIAN',
  DATA_CUSTODIAN = 'CATALYST::DATA_CUSTODIAN',
  USER = 'CATALYST::USER',
  TELEMETRY_EXPORTER = 'CATALYST::TELEMETRY_EXPORTER',
}

/**
 * Maps Role enum values to their corresponding Cedar Principal types.
 */
export const ROLE_TO_PRINCIPAL: Record<Role, Principal> = {
  [Role.ADMIN]: Principal.ADMIN,
  [Role.NODE]: Principal.NODE,
  [Role.NODE_CUSTODIAN]: Principal.NODE_CUSTODIAN,
  [Role.DATA_CUSTODIAN]: Principal.DATA_CUSTODIAN,
  [Role.USER]: Principal.USER,
  [Role.TELEMETRY_EXPORTER]: Principal.TELEMETRY_EXPORTER,
}

/**
 * Standardized actions for the Catalyst system.
 */
export enum Action {
  LOGIN = 'LOGIN',
  MANAGE = 'MANAGE',
  IBGP_CONNECT = 'IBGP_CONNECT',
  IBGP_DISCONNECT = 'IBGP_DISCONNECT',
  IBGP_UPDATE = 'IBGP_UPDATE',
  PEER_CREATE = 'PEER_CREATE',
  PEER_UPDATE = 'PEER_UPDATE',
  PEER_DELETE = 'PEER_DELETE',
  ROUTE_CREATE = 'ROUTE_CREATE',
  ROUTE_DELETE = 'ROUTE_DELETE',
  TOKEN_CREATE = 'TOKEN_CREATE',
  TOKEN_REVOKE = 'TOKEN_REVOKE',
  TOKEN_LIST = 'TOKEN_LIST',
  TELEMETRY_EXPORT = 'TELEMETRY_EXPORT',
}

/**
 * Default role-to-action permissions mapping.
 * Used as a reference for policy generation and documentation.
 */
export const ROLE_PERMISSIONS: Record<Role, Action[]> = {
  [Role.ADMIN]: Object.values(Action),
  [Role.NODE]: [Action.IBGP_CONNECT, Action.IBGP_DISCONNECT, Action.IBGP_UPDATE],
  [Role.NODE_CUSTODIAN]: [
    Action.PEER_CREATE,
    Action.PEER_UPDATE,
    Action.PEER_DELETE,
    Action.IBGP_CONNECT,
    Action.IBGP_DISCONNECT,
    Action.IBGP_UPDATE,
  ],
  [Role.DATA_CUSTODIAN]: [Action.ROUTE_CREATE, Action.ROUTE_DELETE],
  [Role.USER]: [Action.LOGIN],
  [Role.TELEMETRY_EXPORTER]: [Action.TELEMETRY_EXPORT],
}
