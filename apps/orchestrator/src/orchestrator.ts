import type { z } from 'zod'
import {
  Actions,
  newRouteTable,
  type Action,
  type DataChannelDefinition,
  type InternalRoute,
  type PeerInfo,
  type PeerRecord,
  type RouteTable,
  type UpdateMessageSchema,
} from '@catalyst/routing'
export type { PeerInfo, InternalRoute }
import { getLogger } from '@catalyst/telemetry'
import { type OrchestratorConfig, OrchestratorConfigSchema } from './types.js'
import {
  createPortAllocator,
  type PortAllocator,
} from '@catalyst/envoy-service/src/port-allocator.js'
import {
  newHttpBatchRpcSession,
  newWebSocketRpcSession,
  type RpcCompatible,
  type RpcStub,
  RpcTarget,
} from 'capnweb'

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

/**
 * Auth Service RPC API interface
 */
interface AuthServicePermissionsHandlers {
  authorizeAction(request: {
    action: string
    nodeContext: { nodeId: string; domain: string }
  }): Promise<
    | { success: true; allowed: boolean }
    | {
        success: false
        errorType:
          | 'token_expired'
          | 'token_malformed'
          | 'token_revoked'
          | 'permission_denied'
          | 'system_error'
        reason?: string
        reasons?: string[]
      }
  >
}

interface AuthServiceApi {
  permissions(token: string): Promise<AuthServicePermissionsHandlers | { error: string }>
}

export class CatalystNodeBus extends RpcTarget {
  private readonly logger = getLogger(['catalyst', 'orchestrator'])
  private state: RouteTable
  private connectionPool: ConnectionPool
  private config: OrchestratorConfig
  private nodeToken?: string
  private authClient?: RpcStub<AuthServiceApi>
  private portAllocator?: PortAllocator
  public lastNotificationPromise?: Promise<void>

  constructor(opts: {
    state?: RouteTable
    connectionPool?: { type?: 'ws' | 'http'; pool?: ConnectionPool }
    config: OrchestratorConfig
    nodeToken?: string
    authEndpoint?: string
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
    this.nodeToken = opts.nodeToken
    if (opts.authEndpoint) {
      this.authClient = newWebSocketRpcSession<AuthServiceApi>(opts.authEndpoint)
    }
    this.connectionPool =
      opts.connectionPool?.pool ??
      (opts.connectionPool?.type
        ? new ConnectionPool(opts.connectionPool.type)
        : new ConnectionPool())

    if (this.config.envoyConfig?.portRange) {
      this.portAllocator = createPortAllocator(this.config.envoyConfig.portRange)
    }

    this.validateNodeConfig()
  }

  private validateNodeConfig() {
    const { name, domain } = this.config.node
    if (domain && !name.endsWith(`.${domain}`)) {
      throw new Error(
        `Node name ${name} does not match configured domain: ${domain}. Expected format: {nodeId}.${domain}`
      )
    }
  }

  /**
   * Validates an incoming caller token using the auth service permissions API.
   *
   * @param callerToken - The token provided by the caller that needs validation
   * @param action - The action the caller wants to perform
   */
  private async validateToken(
    callerToken: string,
    action: string
  ): Promise<{ valid: true } | { valid: false; error: string }> {
    // If no auth client is configured, allow the operation (for testing/development)
    if (!this.authClient) {
      return { valid: true }
    }

    try {
      // Use permissions API to validate the caller's token
      const permissionsApi = await this.authClient.permissions(callerToken)
      if ('error' in permissionsApi) {
        return { valid: false, error: `Invalid token: ${permissionsApi.error}` }
      }

      // Check if the validated token allows the requested action
      const result = await permissionsApi.authorizeAction({
        action,
        nodeContext: {
          nodeId: this.config.node.name,
          domain: this.config.node.domain,
        },
      })

      if (!result.success) {
        return {
          valid: false,
          error: `Authorization failed: ${result.errorType} - ${result.reason || result.reasons?.join(', ')}`,
        }
      }

      if (!result.allowed) {
        return { valid: false, error: 'Permission denied' }
      }

      return { valid: true }
    } catch (error) {
      return { valid: false, error: `Token validation failed: ${error}` }
    }
  }

  async dispatch(
    sentAction: Action
  ): Promise<{ success: true } | { success: false; error: string }> {
    this.logger.info`Dispatching action: ${sentAction.action}`

    const prevState = this.state

    // Log detailed data for route creation to debug
    if (sentAction.action === Actions.LocalRouteCreate) {
      this.logger.debug`Route create data: ${JSON.stringify(sentAction.data)}`
    }

    const result = await this.handleAction(sentAction, this.state)
    if (result.success) {
      this.state = result.state
      // Fire and forget side effects to avoid deadlocks in distributed calls

      // Note: Hono's waitUntil is not available here easily as we are in the core class.
      // The catch below handles unhandled rejections for the side effect chain.
      // Ideally in a serverless evironment we would use ctx.waitUntil.
      this.lastNotificationPromise = this.handleNotify(sentAction, this.state, prevState).catch(
        (e) => {
          this.logger.error`Error in handleNotify for ${sentAction.action}: ${e}`
        }
      )
      return { success: true }
    } else {
      this.logger.error`Action failed: ${sentAction.action} - ${result.error}`
    }
    return result
  }

  async handleAction(
    action: Action,
    state: RouteTable
  ): Promise<{ success: true; state: RouteTable } | { success: false; error: string }> {
    // Permission enforcement is now handled via token validation in client methods
    // (getIBGPClient, getNetworkClient, getDataChannelClient)
    // This method assumes the caller has already been authorized

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
                domain: action.data.domain,
                peerToken: action.data.peerToken,
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
                    domain: action.data.domain,
                    peerToken: action.data.peerToken,
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
        const { peerInfo, update } = action.data
        this.logger
          .info`InternalProtocolUpdate: received ${update.updates.length} updates from ${peerInfo.name}`
        const sourcePeerName = peerInfo.name
        let currentInternalRoutes = [...state.internal.routes]

        for (const u of update.updates) {
          if (u.action === 'add') {
            const nodePath = u.nodePath ?? []

            // Loop Prevention
            if (nodePath.includes(this.config.node.name)) {
              this.logger
                .debug`Drop update from ${peerInfo.name}: loop detected in path [${nodePath.join(', ')}]`
              continue
            }

            // Remove existing if any (upsert)
            currentInternalRoutes = currentInternalRoutes.filter(
              (r) => !(r.name === u.route.name && r.peerName === sourcePeerName)
            )
            currentInternalRoutes.push({
              ...u.route,
              peerName: sourcePeerName,
              peer: peerInfo,
              nodePath: nodePath,
            })
          } else if (u.action === 'remove') {
            currentInternalRoutes = currentInternalRoutes.filter(
              (r) => r.name !== u.route.name || r.peerName !== sourcePeerName
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
        this.logger.warn`Unknown action: ${(action as Action).action}`
        break
      }
    }

    return { success: true, state }
  }

  private async handleGraphqlConfiguration() {
    const gatewayEndpoint = this.config.gqlGatewayConfig?.endpoint
    if (!gatewayEndpoint) return

    const graphqlRoutes = [...this.state.local.routes, ...this.state.internal.routes].filter(
      (r) => r.protocol === 'http:graphql' || r.protocol === 'http:gql'
    )

    if (graphqlRoutes.length === 0) {
      this.logger.debug`No GraphQL routes to sync`
      return
    }

    this.logger.info`Syncing ${graphqlRoutes.length} GraphQL routes to gateway`

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
          this.logger.error`Gateway sync failed: ${result.error}`
        } else {
          this.logger.info`Gateway sync successful`
        }
      }
    } catch (e) {
      this.logger.error`Error syncing to gateway: ${e}`
    }
  }

  async handleBGPNotify(action: Action, _state: RouteTable, prevState: RouteTable): Promise<void> {
    switch (action.action) {
      case Actions.LocalPeerCreate: {
        // Perform side effect: Try to open connection
        try {
          this.logger
            .info`LocalPeerCreate: attempting connection to ${action.data.name} at ${action.data.endpoint}`
          const stub = this.connectionPool.get(action.data.endpoint)
          if (stub) {
            // Use peer-specific token if available, otherwise fall back to node token
            const token = action.data.peerToken || this.nodeToken || ''
            const connectionResult = await stub.getIBGPClient(token)

            if (connectionResult.success) {
              const result = await connectionResult.client.open(this.config.node)

              if (result.success) {
                this.logger.info`Successfully opened connection to ${action.data.name}`
                // Dispatch connected action
                await this.dispatch({
                  action: Actions.InternalProtocolConnected,
                  data: { peerInfo: action.data },
                })
              }
            } else {
              this.logger.error`Failed to get peer connection: ${connectionResult.error}`
            }
          }
        } catch (e) {
          // Connection failed, leave as initializing (or could transition to error state)
          this.logger.error`Failed to open connection to ${action.data.name}: ${e}`
        }
        break
      }
      case Actions.InternalProtocolOpen: {
        this.logger.info`InternalProtocolOpen: sync request from ${action.data.peerInfo.name}`
        // Sync existing routes (local AND internal) back to the new peer
        const allRoutes = [
          ..._state.local.routes.map((r) => ({
            action: 'add' as const,
            route: r,
            nodePath: [this.config.node.name],
          })),
          ..._state.internal.routes
            .filter((r) => !r.nodePath.includes(action.data.peerInfo.name))
            .map((r) => ({
              action: 'add' as const,
              route: r,
              nodePath: [this.config.node.name, ...r.nodePath],
            })),
        ]

        if (allRoutes.length > 0) {
          try {
            const stub = this.connectionPool.get(action.data.peerInfo.endpoint)
            if (stub) {
              const token = action.data.peerInfo.peerToken || this.nodeToken || ''
              const connectionResult = await stub.getIBGPClient(token)
              if (connectionResult.success) {
                await connectionResult.client.update(this.config.node, {
                  updates: allRoutes,
                })
              }
            }
          } catch (e) {
            this.logger.error`Failed to sync routes back to ${action.data.peerInfo.name}: ${e}`
          }
        }
        break
      }
      case Actions.InternalProtocolConnected: {
        // Sync existing routes (local AND internal) to the new peer
        const allRoutes = [
          ..._state.local.routes.map((r) => ({
            action: 'add' as const,
            route: r,
            nodePath: [this.config.node.name],
          })),
          ..._state.internal.routes
            .filter((r) => !r.nodePath.includes(action.data.peerInfo.name))
            .map((r) => ({
              action: 'add' as const,
              route: r,
              nodePath: [this.config.node.name, ...r.nodePath],
            })),
        ]

        if (allRoutes.length > 0) {
          try {
            const stub = this.connectionPool.get(action.data.peerInfo.endpoint)
            if (stub) {
              const token = action.data.peerInfo.peerToken || this.nodeToken || ''
              const connectionResult = await stub.getIBGPClient(token)
              if (connectionResult.success) {
                await connectionResult.client.update(this.config.node, {
                  updates: allRoutes,
                })
              }
            }
          } catch (e) {
            this.logger.error`Failed to sync routes to ${action.data.peerInfo.name}: ${e}`
          }
        }
        break
      }
      case Actions.LocalPeerDelete: {
        // 1. Close connection to the deleted peer
        const peer = prevState.internal.peers.find((p) => p.name === action.data.name)
        if (peer) {
          try {
            const stub = this.connectionPool.get(peer.endpoint)
            if (stub) {
              const token = peer.peerToken || this.nodeToken || ''
              const connectionResult = await stub.getIBGPClient(token)
              if (connectionResult.success) {
                await connectionResult.client.close(this.config.node, 1000, 'Peer removed')
              }
            }
          } catch (e) {
            this.logger.error`Failed to close connection to ${peer.name}: ${e}`
          }
        }

        // 2. Propagate removal of routes learned FROM this peer to OTHER peers
        await this.propagateWithdrawalsForPeer(action.data.name, prevState, _state)
        break
      }
      case Actions.LocalRouteCreate: {
        // Broadcast to all connected internal peers
        const connectedPeers = _state.internal.peers.filter(
          (p) => p.connectionStatus === 'connected'
        )
        this.logger
          .info`LocalRouteCreate: ${action.data.name}, broadcasting to ${connectedPeers.length} peers`
        for (const peer of connectedPeers) {
          try {
            const stub = this.connectionPool.get(peer.endpoint)
            if (stub) {
              this.logger.debug`Pushing local route ${action.data.name} to ${peer.name}`
              const token = peer.peerToken || this.nodeToken || ''
              const connectionResult = await stub.getIBGPClient(token)
              if (connectionResult.success) {
                await connectionResult.client.update(this.config.node, {
                  updates: [
                    { action: 'add', route: action.data, nodePath: [this.config.node.name] },
                  ],
                })
              }
            }
          } catch (e) {
            this.logger.error`Failed to broadcast route to ${peer.name}: ${e}`
          }
        }
        break
      }
      case Actions.LocalRouteDelete: {
        for (const peer of _state.internal.peers.filter(
          (p) => p.connectionStatus === 'connected'
        )) {
          try {
            const stub = this.connectionPool.get(peer.endpoint)
            if (stub) {
              const token = peer.peerToken || this.nodeToken || ''
              const connectionResult = await stub.getIBGPClient(token)
              if (connectionResult.success) {
                await connectionResult.client.update(this.config.node, {
                  updates: [{ action: 'remove', route: action.data }],
                })
              }
            }
          } catch (e) {
            this.logger.error`Failed to broadcast route removal to ${peer.name}: ${e}`
          }
        }
        break
      }
      case Actions.InternalProtocolUpdate: {
        const sourcePeerName = action.data.peerInfo.name
        for (const peer of _state.internal.peers.filter(
          (p) => p.connectionStatus === 'connected' && p.name !== sourcePeerName
        )) {
          try {
            // Filter out updates that have a loop (including the local node,
            // as we should have already dropped them, and the target peer,
            // as they would drop it anyway).
            const safeUpdates = action.data.update.updates.filter((u) => {
              if (u.action === 'remove') return true
              const path = u.nodePath ?? []
              if (path.includes(this.config.node.name)) return false
              if (path.includes(peer.name)) return false
              return true
            })

            if (safeUpdates.length === 0) continue

            const stub = this.connectionPool.get(peer.endpoint)
            if (stub) {
              const token = peer.peerToken || this.nodeToken || ''
              const connectionResult = await stub.getIBGPClient(token)
              if (connectionResult.success) {
                // Prepend my FQDN to the path of propagated updates
                const updatesWithPrepend = {
                  updates: safeUpdates.map((u) => {
                    if (u.action === 'add') {
                      return {
                        ...u,
                        nodePath: [this.config.node.name, ...(u.nodePath ?? [])],
                      }
                    }
                    return u
                  }),
                }
                await connectionResult.client.update(this.config.node, updatesWithPrepend)
              }
            }
          } catch (e) {
            this.logger.error`Failed to propagate update to ${peer.name}: ${e}`
          }
        }
        break
      }
      case Actions.InternalProtocolClose: {
        await this.propagateWithdrawalsForPeer(action.data.peerInfo.name, prevState, _state)
        break
      }
    }
  }

  private async handleEnvoyConfiguration(
    action: Action,
    _state: RouteTable,
    prevState: RouteTable
  ): Promise<void> {
    const envoyEndpoint = this.config.envoyConfig?.endpoint
    if (!envoyEndpoint || !this.portAllocator) return

    // Only react to route-affecting actions
    const routeActions = [
      Actions.LocalRouteCreate,
      Actions.LocalRouteDelete,
      Actions.InternalProtocolUpdate,
      Actions.InternalProtocolClose,
      Actions.InternalProtocolOpen,
      Actions.InternalProtocolConnected,
    ]
    if (!routeActions.includes(action.action)) return

    // Allocate ports for local routes that need them
    for (const route of this.state.local.routes) {
      if (!route.envoyPort) {
        const result = this.portAllocator.allocate(route.name)
        if (result.success) {
          route.envoyPort = result.port
        } else {
          this.logger.error`Port allocation failed for ${route.name}: ${result.error}`
        }
      }
    }

    // Release ports for deleted local routes
    if (action.action === Actions.LocalRouteDelete) {
      const deletedRoute = prevState.local.routes.find(
        (r) => !this.state.local.routes.some((lr) => lr.name === r.name)
      )
      if (deletedRoute) {
        this.portAllocator.release(deletedRoute.name)
      }
    }

    // Allocate egress ports for internal routes
    for (const route of this.state.internal.routes) {
      if (!route.envoyPort) {
        const egressKey = `egress_${route.name}_via_${route.peerName}`
        const result = this.portAllocator.allocate(egressKey)
        if (result.success) {
          route.envoyPort = result.port
        } else {
          this.logger.error`Egress port allocation failed for ${egressKey}: ${result.error}`
        }
      }
    }

    // Release egress ports for closed peer connections
    if (action.action === Actions.InternalProtocolClose) {
      const closedPeer = action.data.peerInfo.name
      const removedRoutes = prevState.internal.routes.filter((r) => r.peerName === closedPeer)
      for (const route of removedRoutes) {
        this.portAllocator.release(`egress_${route.name}_via_${route.peerName}`)
      }
    }

    // Push complete config to envoy service (fire-and-forget)
    try {
      const stub = this.connectionPool.get(envoyEndpoint)
      if (stub) {
        // @ts-expect-error - Envoy RPC stub typed separately
        const result = await stub.updateRoutes({
          local: this.state.local.routes,
          internal: this.state.internal.routes,
        })
        if (!result.success) {
          this.logger.error`Envoy config sync failed: ${result.error}`
        }
      }
    } catch (e) {
      this.logger.error`Error syncing to Envoy service: ${e}`
    }
  }

  /**
   * Handle side effects after state changes.
   */
  async handleNotify(action: Action, _state: RouteTable, prevState: RouteTable): Promise<void> {
    await this.handleEnvoyConfiguration(action, _state, prevState)
    await this.handleBGPNotify(action, _state, prevState)
    await this.handleGraphqlConfiguration()
  }

  private async propagateWithdrawalsForPeer(
    peerName: string,
    prevState: RouteTable,
    newState: RouteTable
  ) {
    const removedRoutes = prevState.internal.routes.filter((r) => r.peerName === peerName)
    if (removedRoutes.length === 0) return

    this.logger.info`Propagating withdrawal of ${removedRoutes.length} routes from ${peerName}`

    for (const peer of newState.internal.peers.filter(
      (p) => p.connectionStatus === 'connected' && p.name !== peerName
    )) {
      try {
        const stub = this.connectionPool.get(peer.endpoint)
        if (stub) {
          const token = peer.peerToken || this.nodeToken || ''
          const connectionResult = await stub.getIBGPClient(token)

          if (connectionResult.success) {
            await connectionResult.client.update(this.config.node, {
              updates: removedRoutes.map((r) => ({ action: 'remove' as const, route: r })),
            })
          }
        }
      } catch (e) {
        this.logger.error`Failed to propagate withdrawal to ${peer.name}: ${e}`
      }
    }
  }

  publicApi(): PublicApi {
    return {
      getNetworkClient: async (
        token: string
      ): Promise<{ success: true; client: NetworkClient } | { success: false; error: string }> => {
        // Validate token via auth service or fallback to secret
        const validation = await this.validateToken(token, 'PEER_CREATE')
        if (!validation.valid) {
          return { success: false, error: validation.error }
        }

        return {
          success: true,
          client: {
            addPeer: async (peer: PeerInfo) => {
              return this.dispatch({ action: Actions.LocalPeerCreate, data: peer })
            },
            updatePeer: async (peer: PeerInfo) => {
              return this.dispatch({ action: Actions.LocalPeerUpdate, data: peer })
            },
            removePeer: async (peer: Pick<PeerInfo, 'name'>) => {
              return this.dispatch({ action: Actions.LocalPeerDelete, data: peer })
            },
            listPeers: async () => {
              return this.state.internal.peers
            },
          },
        }
      },
      getDataChannelClient: async (
        token: string
      ): Promise<{ success: true; client: DataChannel } | { success: false; error: string }> => {
        // Validate token via auth service or fallback to secret
        const validation = await this.validateToken(token, 'ROUTE_CREATE')
        if (!validation.valid) {
          return { success: false, error: validation.error }
        }

        return {
          success: true,
          client: {
            addRoute: async (route: DataChannelDefinition) => {
              return this.dispatch({ action: Actions.LocalRouteCreate, data: route })
            },
            removeRoute: async (route: DataChannelDefinition) => {
              return this.dispatch({ action: Actions.LocalRouteDelete, data: route })
            },
            listRoutes: async () => {
              return {
                local: this.state.local.routes,
                internal: this.state.internal.routes,
              }
            },
          },
        }
      },
      getIBGPClient: async (
        token: string
      ): Promise<{ success: true; client: IBGPClient } | { success: false; error: string }> => {
        // Validate token via auth service or fallback to secret
        const validation = await this.validateToken(token, 'IBGP_CONNECT')
        if (!validation.valid) {
          return { success: false, error: validation.error }
        }

        return {
          success: true,
          client: {
            open: async (peer: PeerInfo) => {
              return this.dispatch({
                action: Actions.InternalProtocolOpen,
                data: { peerInfo: peer },
              })
            },
            close: async (peer: PeerInfo, code: number, reason?: string) => {
              return this.dispatch({
                action: Actions.InternalProtocolClose,
                data: { peerInfo: peer, code, reason },
              })
            },
            update: async (peer: PeerInfo, update: z.infer<typeof UpdateMessageSchema>) => {
              return this.dispatch({
                action: Actions.InternalProtocolUpdate,
                data: {
                  peerInfo: peer,
                  update: update,
                },
              })
            },
          },
        }
      },
      dispatch: async (action: Action) => {
        return this.dispatch(action)
      },
    }
  }
}
