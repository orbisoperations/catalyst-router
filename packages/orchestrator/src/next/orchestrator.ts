import { z } from 'zod'
import { type Action } from './schema.js'
import type { PeerInfo, InternalRoute } from './routing/state.js'
import { newRouteTable, type RouteTable } from './routing/state.js'
import type { DataChannelDefinition } from './routing/datachannel.js'
import type { UpdateMessageSchema } from './routing/internal/actions.js'
import { type AuthContext, AuthContextSchema } from './types.js'
import { getRequiredPermission, hasPermission, isSecretValid } from './permissions.js'
import { Actions } from './action-types.js'
import {
  newHttpBatchRpcSession,
  newWebSocketRpcSession,
  type RpcCompatible,
  type RpcStub,
  RpcTarget,
} from 'capnweb'

export interface PublicApi {
  getManagerConnection(): PeerManager
  getPeerConnection(
    secret: string
  ): { success: true; connection: PeerConnection } | { success: false; error: string }
  getInspector(): Inspector
  dispatch(
    action: Action,
    auth?: AuthContext
  ): Promise<{ success: true } | { success: false; error: string }>
}

export interface Inspector {
  listPeers(): Promise<PeerInfo[]>
  listRoutes(): Promise<{ local: DataChannelDefinition[]; internal: InternalRoute[] }>
  listRoutes(): Promise<{ local: DataChannelDefinition[]; internal: InternalRoute[] }>
}

export interface PeerManager {
  addPeer(
    peer: PeerInfo,
    auth?: AuthContext
  ): Promise<{ success: true } | { success: false; error: string }>
  updatePeer(
    peer: PeerInfo,
    auth?: AuthContext
  ): Promise<{ success: true } | { success: false; error: string }>
  removePeer(
    peer: Pick<PeerInfo, 'name'>,
    auth?: AuthContext
  ): Promise<{ success: true } | { success: false; error: string }>
}

export interface PeerConnection {
  open(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
  close(
    peer: PeerInfo,
    code: number,
    reason?: string
  ): Promise<{ success: true } | { success: false; error: string }>
  update(
    peer: PeerInfo,
    update: z.infer<typeof UpdateMessageSchema>
  ): Promise<{ success: true } | { success: false; error: string }>
}

export function getHttpPeerSession<API extends RpcCompatible<API>>(endpoint: string) {
  return newHttpBatchRpcSession<API>(endpoint)
}

export function getWebSocketPeerSession<API extends RpcCompatible<API>>(endpoint: string) {
  return newWebSocketRpcSession<API>(endpoint)
}

export class ConnectionPool {
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

export interface OrchestratorConfig {
  node: PeerInfo
  ibgp?: {
    secret?: string
  }
  gqlGatewayConfig?: {
    endpoint: string
  }
}

export class CatalystNodeBus extends RpcTarget {
  private state: RouteTable
  private connectionPool: ConnectionPool
  private config: OrchestratorConfig

  constructor(opts: {
    state?: RouteTable
    connectionPool?: { type?: 'ws' | 'http'; pool?: ConnectionPool }
    config: OrchestratorConfig
  }) {
    super()
    this.state = opts.state ?? newRouteTable()
    const parsedConfig = OrchestratorConfigSchema.safeParse(opts.config)
    if (!parsedConfig.success) {
      throw new Error(
        `Invalid CatalystNodeBus config: ${parsedConfig.error.issues.map((a) => a.message).join(', ')}`
      )
    }
    this.config = opts.config
    this.connectionPool =
      opts.connectionPool?.pool ??
      (opts.connectionPool?.type
        ? new ConnectionPool(opts.connectionPool.type)
        : new ConnectionPool())

    this.validateNodeConfig()
  }

  private validateNodeConfig() {
    const { name, domains } = this.config.node
    if (!name.endsWith('.somebiz.local.io')) {
      throw new Error(`Invalid node name: ${name}. Must end with .somebiz.local.io`)
    }
    const domainMatch = domains.some((d) => name.endsWith(`.${d}`))
    if (!domainMatch && domains.length > 0) {
      throw new Error(
        `Node name ${name} does not match any configured domains: ${domains.join(', ')}`
      )
    }
  }

  async dispatch(
    sentAction: Action,
    auth?: AuthContext
  ): Promise<{ success: true } | { success: false; error: string }> {
    // Validate and default to anonymous context
    const resolvedAuth: AuthContext = auth
      ? AuthContextSchema.parse(auth)
      : { userId: 'anonymous', roles: [] }
    const resolvedAuth: AuthContext = auth
      ? AuthContextSchema.parse(auth)
      : { userId: 'anonymous', roles: [] }

    const prevState = this.state
    const result = await this.handleAction(sentAction, this.state, resolvedAuth)
    if (result.success) {
      this.state = result.state
      // Fire notifications/side-effects after state update
      await this.handleNotify(sentAction, result.state, prevState, resolvedAuth)
      return { success: true }
    }
    return result
  }

  async handleAction(
    action: Action,
    state: RouteTable,
    auth: AuthContext
  ): Promise<{ success: true; state: RouteTable } | { success: false; error: string }> {
    // Permission check - single enforcement point
    const requiredPermission = getRequiredPermission(action)
    if (!hasPermission(auth.roles, requiredPermission)) {
      console.error(
        `[CatalystNodeBus] Permission denied: action:${action} roles:${auth.roles} required:${requiredPermission}`
      )
      return { success: false, error: `Permission denied: ${requiredPermission}` }
    }

    switch (action.action) {
      case Actions.LocalPeerCreate: {
        const peerList = state.internal.peers
        if (peerList.find((p) => p.name === action.data.name)) {
          return { success: false, error: 'Peer already exists' }
        }

        // Optimistically add peer as initializing
        const newState = {
          ...state,
          internal: {
            ...state.internal,
            peers: [
              ...state.internal.peers,
              {
                name: action.data.name,
                endpoint: action.data.endpoint,
                domains: action.data.domains,
                connectionStatus: 'initializing' as const,
                lastConnected: undefined,
              },
            ],
          },
        }

        state = newState
        break
      }
      case Actions.LocalPeerUpdate: {
        const peerList = state.internal.peers
        const peer = peerList.find((p) => p.name === action.data.name)
        if (!peer) {
          return { success: false, error: 'Peer not found' }
        }
        state = {
          ...state,
          internal: {
            ...state.internal,
            peers: peerList.map((p) =>
              p.name === action.data.name
                ? {
                    ...p,
                    endpoint: action.data.endpoint,
                    domains: action.data.domains,
                    connectionStatus: 'initializing',
                    lastConnected: undefined,
                  }
                    ...p,
                    endpoint: action.data.endpoint,
                    domains: action.data.domains,
                    connectionStatus: 'initializing',
                    lastConnected: undefined,
                  }
                : p
            ),
          },
        }
        break
      }
      case Actions.LocalPeerDelete: {
        const peerList = state.internal.peers
        const peer = peerList.find((p) => p.name === action.data.name)
        if (!peer) {
          return { success: false, error: 'Peer not found' }
        }
        state = {
          ...state,
          internal: {
            ...state.internal,
            peers: peerList.filter((p) => p.name !== action.data.name),
          },
        }
        break
      }
      case Actions.InternalProtocolClose: {
        const peerList = state.internal.peers
        // Find peer by matching info from sender
        const peer = peerList.find((p) => p.name === action.data.peerInfo.name)

        // If found, remove it. If not found, it's already gone or never existed.
        if (peer) {
          state = {
            ...state,
            internal: {
              ...state.internal,
              routes: state.internal.routes.filter((r) => r.peerName !== action.data.peerInfo.name),
              peers: peerList.filter((p) => p.name !== action.data.peerInfo.name),
            },
          }
        }
        break
      }
      case Actions.InternalProtocolOpen: {
        const peer = state.internal.peers.find((p) => p.name === action.data.peerInfo.name)
        if (!peer) {
          return {
            success: false,
            error: `Peer '${action.data.peerInfo.name}' is not configured on this node`,
          }
        }

        if (peer.connectionStatus !== 'connected') {
          state = {
            ...state,
            internal: {
              ...state.internal,
              peers: state.internal.peers.map((p) =>
                p.name === action.data.peerInfo.name ? { ...p, connectionStatus: 'connected' } : p
              ),
            },
          }
        }
        break
      }
      case Actions.InternalProtocolConnected: {
        const peerList = state.internal.peers
        const peer = peerList.find((p) => p.name === action.data.peerInfo.name)
        if (peer) {
          state = {
            ...state,
            internal: {
              ...state.internal,
              peers: state.internal.peers.map((p) =>
                p.name === action.data.peerInfo.name ? { ...p, connectionStatus: 'connected' } : p
              ),
            },
          }
        }
        break
      }
      case Actions.LocalRouteCreate: {
        // Check if route already exists
        if (state.local.routes.find((r) => r.name === action.data.name)) {
          return { success: false, error: 'Route already exists' }
        }
        state = {
          ...state,
          local: {
            ...state.local,
            routes: [...state.local.routes, action.data],
          },
        }
        break
      }
      case Actions.LocalRouteDelete: {
        // Check if route exists
        if (!state.local.routes.find((r) => r.name === action.data.name)) {
          return { success: false, error: 'Route not found' }
        }
        state = {
          ...state,
          local: {
            ...state.local,
            routes: state.local.routes.filter((r) => r.name !== action.data.name),
          },
        }
        break
      }
      case Actions.InternalProtocolUpdate: {
        const peerInfo = action.data.peerInfo
        let currentInternalRoutes = [...state.internal.routes]

        for (const update of action.data.update.updates) {
          if (update.action === 'add') {
            const nodePath = update.nodePath ?? []

            // Loop Prevention
            if (nodePath.includes(this.config.node.name)) {
              console.log(
                `[${this.config.node.name}] Drop update from ${peerInfo.name}: loop detected in path [${nodePath.join(', ')}]`
              )
              continue
            }

            const routeToAdd = {
              ...update.route,
              peer: peerInfo,
              peerName: peerInfo.name,
              nodePath,
            }

            // Remove existing if any (upsert)
            currentInternalRoutes = currentInternalRoutes.filter(
              (r) => !(r.name === update.route.name && r.peerName === peerInfo.name)
            )
            currentInternalRoutes.push(routeToAdd)
          } else if (update.action === 'remove') {
            currentInternalRoutes = currentInternalRoutes.filter(
              (r) => !(r.name === update.route.name && r.peerName === peerInfo.name)
            )
          }
        }

        state = {
          ...state,
          internal: {
            ...state.internal,
            routes: currentInternalRoutes,
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

  private async syncGateway() {
    const gatewayEndpoint = this.config.gqlGatewayConfig?.endpoint
    if (!gatewayEndpoint) return

    const graphqlRoutes = [...this.state.local.routes, ...this.state.internal.routes].filter(
      (r) => r.protocol === 'http:graphql' || r.protocol === 'http:gql'
    )

    if (graphqlRoutes.length === 0) {
      console.log(`[${this.config.node.name}] No GraphQL routes to sync.`)
      return
    }

    console.log(
      `[${this.config.node.name}] Syncing ${graphqlRoutes.length} GraphQL routes to gateway...`
    )

    try {
      const stub = this.connectionPool.get(gatewayEndpoint)
      if (stub) {
        const config = {
          services: graphqlRoutes.map((r) => ({
            name: r.name,
            url: r.endpoint!,
          })),
        }

        // @ts-expect-error - Gateway RPC implementation uses updateConfig
        const result = await stub.updateConfig(config)
        if (!result.success) {
          console.error(`[${this.config.node.name}] Gateway sync failed:`, result.error)
        } else {
          console.log(`[${this.config.node.name}] Gateway sync successful.`)
        }
      }
    } catch (e) {
      console.error(`[${this.config.node.name}] Error syncing to gateway:`, e)
    }
  }

  /**
   * Handle side effects after state changes.
   */
  async handleNotify(
    action: Action,
    _state: RouteTable,
    prevState: RouteTable,
    auth: AuthContext
  ): Promise<void> {
    switch (action.action) {
      case Actions.LocalPeerCreate: {
        // Perform side effect: Try to open connection
        try {
          const stub = this.connectionPool.get(action.data.endpoint)
          if (stub) {
            const connectionResult = await stub.getPeerConnection('secret')
            if (connectionResult.success) {
              const result = await connectionResult.connection.open(this.config.node)

              if (result.success) {
                // Dispatch connected action with inherited auth
                await this.dispatch(
                  {
                    action: Actions.InternalProtocolConnected,
                    data: { peerInfo: action.data },
                  },
                  auth
                )
              }
            } else {
              console.error('Failed to get peer connection', connectionResult.error)
            }
          }
        } catch (e) {
          // Connection failed, leave as initializing (or could transition to error state)
          console.error(
            `[${this.config.node.name}] Failed to open connection to ${action.data.name}`,
            e
          )
          console.error(
            `[${this.config.node.name}] Failed to open connection to ${action.data.name}`,
            e
          )
        }
        break
      }
      case Actions.InternalProtocolOpen: {
        // Sync existing local routes back to the new peer
        for (const route of _state.local.routes) {
          try {
            const stub = this.connectionPool.get(action.data.peerInfo.endpoint)
            if (stub) {
              const connectionResult = await stub.getPeerConnection('secret')
              if (connectionResult.success) {
                await connectionResult.connection.update(this.config.node, {
                  updates: [{ action: 'add', route, nodePath: [this.config.node.name] }],
                })
              }
            }
          } catch (e) {
            console.error(
              `[${this.config.node.name}] Failed to sync route back to ${action.data.peerInfo.name}`,
              e
            )
            console.error(
              `[${this.config.node.name}] Failed to sync route back to ${action.data.peerInfo.name}`,
              e
            )
          }
        }
        await this.syncGateway()
        break
      }
      case Actions.InternalProtocolConnected: {
        // Sync existing local routes to the new peer
        for (const route of _state.local.routes) {
          try {
            const stub = this.connectionPool.get(action.data.peerInfo.endpoint)
            if (stub) {
              const connectionResult = await stub.getPeerConnection('secret')
              if (connectionResult.success) {
                await connectionResult.connection.update(this.config.node, {
                  updates: [{ action: 'add', route, nodePath: [this.config.node.name] }],
                })
              }
            }
          } catch (e) {
            console.error(
              `[${this.config.node.name}] Failed to sync route to ${action.data.peerInfo.name}`,
              e
            )
            console.error(
              `[${this.config.node.name}] Failed to sync route to ${action.data.peerInfo.name}`,
              e
            )
          }
        }
        await this.syncGateway()
        break
      }
      case Actions.LocalPeerDelete: {
        // Use prevState to find the peer info that was just deleted
        const peer = prevState.internal.peers.find((p) => p.name === action.data.name)
        if (peer) {
          try {
            const stub = this.connectionPool.get(peer.endpoint)
            if (stub) {
              const connectionResult = await stub.getPeerConnection('secret')
              if (connectionResult.success) {
                await connectionResult.connection.close(this.config.node, 1000, 'Peer removed')
              }
            }
          } catch (e) {
            console.error(
              `[${this.config.node.name}] Failed to close connection to ${peer.name}`,
              e
            )
            console.error(
              `[${this.config.node.name}] Failed to close connection to ${peer.name}`,
              e
            )
          }
        }
        break
      }
      case Actions.LocalRouteCreate: {
        for (const peer of _state.internal.peers.filter(
          (p) => p.connectionStatus === 'connected'
        )) {
        for (const peer of _state.internal.peers.filter(
          (p) => p.connectionStatus === 'connected'
        )) {
          try {
            const stub = this.connectionPool.get(peer.endpoint)
            if (stub) {
              const connectionResult = await stub.getPeerConnection('secret')
              if (connectionResult.success) {
                await connectionResult.connection.update(this.config.node, {
                  updates: [
                    { action: 'add', route: action.data, nodePath: [this.config.node.name] },
                  ],
                })
              }
            }
          } catch (e) {
            console.error(`[${this.config.node.name}] Failed to broadcast route to ${peer.name}`, e)
          }
        }
        await this.syncGateway()
        break
      }
      case Actions.LocalRouteDelete: {
        for (const peer of _state.internal.peers.filter(
          (p) => p.connectionStatus === 'connected'
        )) {
        for (const peer of _state.internal.peers.filter(
          (p) => p.connectionStatus === 'connected'
        )) {
          try {
            const stub = this.connectionPool.get(peer.endpoint)
            if (stub) {
              const connectionResult = await stub.getPeerConnection('secret')
              if (connectionResult.success) {
                await connectionResult.connection.update(this.config.node, {
                  updates: [{ action: 'remove', route: action.data }],
                })
              }
            }
          } catch (e) {
            console.error(
              `[${this.config.node.name}] Failed to broadcast route removal to ${peer.name}`,
              e
            )
            console.error(
              `[${this.config.node.name}] Failed to broadcast route removal to ${peer.name}`,
              e
            )
          }
        }
        await this.syncGateway()
        break
      }
      case Actions.InternalProtocolUpdate: {
        const sourcePeerName = action.data.peerInfo.name
        for (const peer of _state.internal.peers.filter(
          (p) => p.connectionStatus === 'connected' && p.name !== sourcePeerName
        )) {
          try {
            const stub = this.connectionPool.get(peer.endpoint)
            if (stub) {
              const connectionResult = await stub.getPeerConnection('secret')
              if (connectionResult.success) {
                // Prepend my FQDN to the path of propagated updates
                const updatesWithPrepend = {
                  updates: action.data.update.updates.map((u) => {
                    if (u.action === 'add') {
                      return {
                        ...u,
                        nodePath: [this.config.node.name, ...(u.nodePath ?? [])],
                      }
                    }
                    return u
                  }),
                }
                await connectionResult.connection.update(this.config.node, updatesWithPrepend)
              }
            }
          } catch (e) {
            console.error(
              `[${this.config.node.name}] Failed to propagate update to ${peer.name}`,
              e
            )
            console.error(
              `[${this.config.node.name}] Failed to propagate update to ${peer.name}`,
              e
            )
          }
        }
        await this.syncGateway()
        break
      }
      case Actions.InternalProtocolClose: {
        await this.syncGateway()
        break
      }
    }
  }

  publicApi(): PublicApi {
    return {
      getManagerConnection: (): PeerManager => {
        return {
          addPeer: async (peer: PeerInfo, auth?: AuthContext) => {
            return this.dispatch({ action: Actions.LocalPeerCreate, data: peer }, auth)
          },
          updatePeer: async (peer: PeerInfo, auth?: AuthContext) => {
            return this.dispatch({ action: Actions.LocalPeerUpdate, data: peer }, auth)
          },
          removePeer: async (peer: Pick<PeerInfo, 'name'>, auth?: AuthContext) => {
            return this.dispatch({ action: Actions.LocalPeerDelete, data: peer }, auth)
          },
        }
      },
      getPeerConnection: (
        secret: string
      ): { success: true; connection: PeerConnection } | { success: false; error: string } => {
        // Validate PSK
        const expectedSecret = this.config?.ibgp?.secret
        if (!expectedSecret || !isSecretValid(secret, expectedSecret)) {
          return { success: false, error: 'Invalid secret' }
        }

        // Create peer auth context with ibgp permissions
        const peerAuth: AuthContext = {
          userId: 'peer:authenticated',
          roles: ['ibgp:connect', 'ibgp:disconnect', 'ibgp:update'],
        }

        return {
          success: true,
          connection: {
            open: async (peer: PeerInfo) => {
              return this.dispatch(
                {
                  action: Actions.InternalProtocolOpen,
                  data: { peerInfo: peer },
                },
                peerAuth
              )
            },
            close: async (peer: PeerInfo, code: number, reason?: string) => {
              return this.dispatch(
                {
                  action: Actions.InternalProtocolClose,
                  data: { peerInfo: peer, code, reason },
                },
                peerAuth
              )
            },
            update: async (peer: PeerInfo, update: z.infer<typeof UpdateMessageSchema>) => {
              return this.dispatch(
                {
                  action: Actions.InternalProtocolUpdate,
                  data: {
                    peerInfo: peer,
                    update: update,
                  },
                },
                peerAuth
              )
            },
          },
        }
      },
      getInspector: (): Inspector => {
        return {
          listPeers: async () => this.state.internal.peers,
          listRoutes: async () => ({
            local: this.state.local.routes,
            internal: this.state.internal.routes,
          }),
        }
      },
      dispatch: async (action: Action) => {
        return this.dispatch(action)
      },
    }
  }
}
