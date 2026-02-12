import {
  Actions,
  newRouteTable,
  type Action,
  type DataChannelDefinition,
  type InternalRoute,
  type PeerInfo,
  type PeerRecord,
  type RouteTable,
} from '@catalyst/routing'
export type { PeerInfo, InternalRoute }
import { getLogger } from '@catalyst/telemetry'
import { type OrchestratorConfig, OrchestratorConfigSchema } from './types.js'
import { createPortAllocator, type PortAllocator } from '@catalyst/envoy-service'
import {
  newHttpBatchRpcSession,
  newWebSocketRpcSession,
  type RpcCompatible,
  type RpcStub,
  RpcTarget,
} from 'capnweb'
import { PeerTransport, type Propagation } from './peer-transport.js'
import type {
  PublicApi,
  NetworkClient,
  DataChannel,
  IBGPClient,
  UpdateMessage,
  EnvoyApi,
  GatewayApi,
} from './api-types.js'
import { ActionQueue, type DispatchResult } from './action-queue.js'

export type { PublicApi, NetworkClient, DataChannel, IBGPClient } from './api-types.js'

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

  get(endpoint: string): RpcStub<PublicApi> {
    const cached = this.stubs.get(endpoint)
    if (cached) {
      return cached
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

  getEnvoy(endpoint: string): RpcStub<EnvoyApi> {
    return this.get(endpoint) as unknown as RpcStub<EnvoyApi>
  }

  getGateway(endpoint: string): RpcStub<GatewayApi> {
    return this.get(endpoint) as unknown as RpcStub<GatewayApi>
  }
}

/**
 * Auth Service RPC API interface
 */
interface AuthServicePermissionsHandlers {
  authorizeAction(request: {
    action: string
    nodeContext: { nodeId: string; domains: string[] }
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
  private peerTransport: PeerTransport
  private config: OrchestratorConfig
  private nodeToken?: string
  private authClient?: RpcStub<AuthServiceApi>
  private portAllocator?: PortAllocator
  private queue: ActionQueue
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

    this.peerTransport = new PeerTransport(this.connectionPool, this.nodeToken)

    if (this.config.envoyConfig?.portRange) {
      this.portAllocator = createPortAllocator(this.config.envoyConfig.portRange)
    }

    this.validateNodeConfig()
    this.queue = new ActionQueue((action) => this.pipeline(action))
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
          domains: this.config.node.domains,
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

  async dispatch(sentAction: Action): Promise<DispatchResult> {
    return this.queue.enqueue(sentAction)
  }

  private async pipeline(sentAction: Action): Promise<DispatchResult> {
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
        if (!action.data.peerToken) {
          return { success: false, error: 'peerToken is required when creating a peer' }
        }
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
                    domains: action.data.domains,
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

  private buildRouteSyncPayload(
    state: RouteTable,
    targetPeerName: string
  ): { updates: Array<{ action: 'add'; route: DataChannelDefinition; nodePath: string[] }> } {
    return {
      updates: [
        ...state.local.routes.map((r) => ({
          action: 'add' as const,
          route: r,
          nodePath: [this.config.node.name],
        })),
        ...state.internal.routes
          .filter((r) => !r.nodePath.includes(targetPeerName))
          .map((r) => {
            let route = r as DataChannelDefinition
            if (this.config.envoyConfig && this.portAllocator) {
              const egressKey = `egress_${r.name}_via_${r.peerName}`
              const localPort = this.portAllocator.getPort(egressKey)
              if (localPort) {
                route = { ...r, envoyPort: localPort }
              }
            }
            return {
              action: 'add' as const,
              route,
              nodePath: [this.config.node.name, ...r.nodePath],
            }
          }),
      ],
    }
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
      const stub = this.connectionPool.getGateway(gatewayEndpoint)
      const config = {
        services: graphqlRoutes.map((r) => ({
          name: r.name,
          url: r.endpoint!,
        })),
      }

      const result = await stub.updateConfig(config)
      if (!result.success) {
        this.logger.error`Gateway sync failed: ${result.error}`
      } else {
        this.logger.info`Gateway sync successful`
      }
    } catch (e) {
      this.logger.error`Error syncing to gateway: ${e}`
    }
  }

  async handleBGPNotify(action: Action, _state: RouteTable, prevState: RouteTable): Promise<void> {
    switch (action.action) {
      case Actions.LocalPeerCreate: {
        this.logger
          .info`LocalPeerCreate: attempting connection to ${action.data.name} at ${action.data.endpoint}`
        try {
          const peerRecord = _state.internal.peers.find((p) => p.name === action.data.name)
          if (peerRecord) {
            await this.peerTransport.sendOpen(peerRecord, this.config.node)
            this.logger.info`Successfully opened connection to ${action.data.name}`
            await this.dispatch({
              action: Actions.InternalProtocolConnected,
              data: { peerInfo: action.data },
            })
          }
        } catch (e) {
          this.logger.error`Failed to open connection to ${action.data.name}: ${e}`
        }
        break
      }
      case Actions.InternalProtocolOpen: {
        this.logger.info`InternalProtocolOpen: sync request from ${action.data.peerInfo.name}`
        const allRoutesOpen = this.buildRouteSyncPayload(_state, action.data.peerInfo.name)

        if (allRoutesOpen.updates.length > 0) {
          const localPeer = _state.internal.peers.find((p) => p.name === action.data.peerInfo.name)
          if (!localPeer?.peerToken) {
            this.logger
              .error`CRITICAL: no peerToken for ${action.data.peerInfo.name} — cannot sync routes`
            break
          }
          try {
            await this.peerTransport.sendUpdate(localPeer, this.config.node, allRoutesOpen)
          } catch (e) {
            this.logger.error`Failed to sync routes back to ${action.data.peerInfo.name}: ${e}`
          }
        }
        break
      }
      case Actions.InternalProtocolConnected: {
        const allRoutesConnected = this.buildRouteSyncPayload(_state, action.data.peerInfo.name)

        if (allRoutesConnected.updates.length > 0) {
          if (!action.data.peerInfo.peerToken) {
            this.logger
              .error`CRITICAL: no peerToken for ${action.data.peerInfo.name} — cannot sync routes`
            break
          }
          const peerRecord: PeerRecord = {
            ...action.data.peerInfo,
            peerToken: action.data.peerInfo.peerToken,
            connectionStatus: 'connected',
          }
          try {
            await this.peerTransport.sendUpdate(peerRecord, this.config.node, allRoutesConnected)
          } catch (e) {
            this.logger.error`Failed to sync routes to ${action.data.peerInfo.name}: ${e}`
          }
        }
        break
      }
      case Actions.LocalPeerDelete: {
        const deletedPeer = prevState.internal.peers.find((p) => p.name === action.data.name)
        if (deletedPeer) {
          try {
            await this.peerTransport.sendClose(deletedPeer, this.config.node, 1000, 'Peer removed')
          } catch (e) {
            this.logger.error`Failed to close connection to ${deletedPeer.name}: ${e}`
          }
        }
        await this.propagateWithdrawalsForPeer(action.data.name, prevState, _state)
        break
      }
      case Actions.LocalRouteCreate: {
        const connectedPeers = _state.internal.peers.filter(
          (p) => p.connectionStatus === 'connected'
        )
        this.logger
          .info`LocalRouteCreate: ${action.data.name}, broadcasting to ${connectedPeers.length} peers`
        const update = {
          updates: [
            { action: 'add' as const, route: action.data, nodePath: [this.config.node.name] },
          ],
        }
        const propagations: Propagation[] = connectedPeers.map((peer) => ({
          type: 'update' as const,
          peer,
          localNode: this.config.node,
          update,
        }))
        await this.peerTransport.fanOut(propagations)
        break
      }
      case Actions.LocalRouteDelete: {
        const connectedPeersDelete = _state.internal.peers.filter(
          (p) => p.connectionStatus === 'connected'
        )
        const deleteUpdate = {
          updates: [{ action: 'remove' as const, route: action.data }],
        }
        const deletePropagations: Propagation[] = connectedPeersDelete.map((peer) => ({
          type: 'update' as const,
          peer,
          localNode: this.config.node,
          update: deleteUpdate,
        }))
        await this.peerTransport.fanOut(deletePropagations)
        break
      }
      case Actions.InternalProtocolUpdate: {
        const sourcePeerName = action.data.peerInfo.name
        const updatePropagations: Propagation[] = []

        for (const peer of _state.internal.peers.filter(
          (p) => p.connectionStatus === 'connected' && p.name !== sourcePeerName
        )) {
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

          // Prepend my FQDN to the path and rewrite envoyPort/envoyAddress
          // for multi-hop: downstream peers must connect to this node's
          // Envoy proxy, not the original upstream's.
          const updatesWithPrepend = {
            updates: safeUpdates.map((u) => {
              if (u.action === 'add') {
                const rewritten = {
                  ...u,
                  nodePath: [this.config.node.name, ...(u.nodePath ?? [])],
                }
                if (this.config.envoyConfig && this.portAllocator) {
                  const egressKey = `egress_${u.route.name}_via_${sourcePeerName}`
                  const localPort = this.portAllocator.getPort(egressKey)
                  if (localPort) {
                    rewritten.route = { ...u.route, envoyPort: localPort }
                  }
                }
                return rewritten
              }
              return u
            }),
          }

          updatePropagations.push({
            type: 'update',
            peer,
            localNode: this.config.node,
            update: updatesWithPrepend,
          })
        }

        await this.peerTransport.fanOut(updatePropagations)
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

    // Allocate egress ports for internal routes.
    // Always allocate a local port (even if route has envoyPort from upstream).
    // The local port is the listener port; route.envoyPort is preserved as the
    // remote cluster target. Port allocations are sent explicitly to the envoy service.
    for (const route of this.state.internal.routes) {
      const egressKey = `egress_${route.name}_via_${route.peerName}`
      const result = this.portAllocator.allocate(egressKey)
      if (result.success) {
        // Only set envoyPort if the upstream didn't provide one.
        // When upstream sets envoyPort, it's preserved for the remote cluster.
        if (!route.envoyPort) {
          route.envoyPort = result.port
        }
      } else {
        this.logger.error`Egress port allocation failed for ${egressKey}: ${result.error}`
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
      const stub = this.connectionPool.getEnvoy(envoyEndpoint)
      const result = await stub.updateRoutes({
        local: this.state.local.routes,
        internal: this.state.internal.routes,
        portAllocations: Object.fromEntries(this.portAllocator.getAllocations()),
      })
      if (!result.success) {
        this.logger.error`Envoy config sync failed: ${result.error}`
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

    const withdrawalUpdate = {
      updates: removedRoutes.map((r) => ({ action: 'remove' as const, route: r })),
    }
    const propagations: Propagation[] = newState.internal.peers
      .filter((p) => p.connectionStatus === 'connected' && p.name !== peerName)
      .map((peer) => ({
        type: 'update' as const,
        peer,
        localNode: this.config.node,
        update: withdrawalUpdate,
      }))

    await this.peerTransport.fanOut(propagations)
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
            update: async (peer: PeerInfo, update: UpdateMessage) => {
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
