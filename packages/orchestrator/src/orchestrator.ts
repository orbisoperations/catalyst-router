import type { z } from 'zod'
import { type Action } from './schema.js'
import { Actions } from './action-types.js'
import type { PeerInfo, InternalRoute } from './routing/state.js'
export type { PeerInfo, InternalRoute }
import { newRouteTable, type RouteTable, type PeerRecord } from './routing/state.js'
import type { DataChannelDefinition } from './routing/datachannel.js'
import type { UpdateMessageSchema } from './routing/internal/actions.js'
import { type OrchestratorConfig, OrchestratorConfigSchema } from './types.js'
import {
  newHttpBatchRpcSession,
  newWebSocketRpcSession,
  type RpcCompatible,
  type RpcStub,
  RpcTarget,
} from 'capnweb'
import { TelemetryBuilder } from '@catalyst/telemetry'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import type { Counter, Histogram } from '@opentelemetry/api'

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
  private state: RouteTable
  private connectionPool: ConnectionPool
  private config: OrchestratorConfig
  private nodeToken?: string
  private authClient?: RpcStub<AuthServiceApi>
  public lastNotificationPromise?: Promise<void>
  private readonly logger: ReturnType<ServiceTelemetry['logger']['getChild']>
  private readonly dispatchDuration: Histogram
  private readonly notifyDuration: Histogram
  private readonly peerEvents: Counter
  private readonly gatewaySyncDuration: Histogram

  constructor(opts: {
    state?: RouteTable
    connectionPool?: { type?: 'ws' | 'http'; pool?: ConnectionPool }
    config: OrchestratorConfig
    nodeToken?: string
    authEndpoint?: string
    telemetry?: ServiceTelemetry
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

    this.validateNodeConfig()

    const telemetry = opts.telemetry ?? TelemetryBuilder.noop('orchestrator')
    this.logger = telemetry.logger

    this.dispatchDuration = telemetry.meter.createHistogram('orchestrator.dispatch.duration', {
      description: 'Duration of dispatch operations',
      unit: 's',
    })
    this.notifyDuration = telemetry.meter.createHistogram('orchestrator.notify.duration', {
      description: 'Duration of handleNotify side effects',
      unit: 's',
    })
    this.peerEvents = telemetry.meter.createCounter('orchestrator.peer.events', {
      description: 'Peer connection lifecycle events',
      unit: '{event}',
    })
    this.gatewaySyncDuration = telemetry.meter.createHistogram(
      'orchestrator.gateway.sync.duration',
      {
        description: 'Duration of gateway configuration sync',
        unit: 's',
      }
    )
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

  async dispatch(
    sentAction: Action
  ): Promise<{ success: true } | { success: false; error: string }> {
    const start = performance.now()
    this.logger.info`dispatch: ${sentAction.action}`

    const prevState = this.state
    const result = await this.handleAction(sentAction, this.state)
    if (result.success) {
      this.state = result.state
      const notifyStart = performance.now()
      this.lastNotificationPromise = this.handleNotify(sentAction, this.state, prevState)
        .then(() => {
          this.notifyDuration.record((performance.now() - notifyStart) / 1000, {
            action: sentAction.action,
          })
        })
        .catch((e) => {
          this.notifyDuration.record((performance.now() - notifyStart) / 1000, {
            action: sentAction.action,
          })
          this.logger.error`handleNotify error for ${sentAction.action}: ${e}`
        })

      this.dispatchDuration.record((performance.now() - start) / 1000, {
        action: sentAction.action,
        success: 'true',
      })
      return { success: true }
    }

    this.logger.error`action failed: ${sentAction.action} - ${result.error}`
    this.dispatchDuration.record((performance.now() - start) / 1000, {
      action: sentAction.action,
      success: 'false',
    })
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
        this.logger.info`received ${update.updates.length} updates from ${peerInfo.name}`
        const sourcePeerName = peerInfo.name
        let currentInternalRoutes = [...state.internal.routes]

        for (const u of update.updates) {
          if (u.action === 'add') {
            const nodePath = u.nodePath ?? []

            // Loop Prevention
            if (nodePath.includes(this.config.node.name)) {
              this.logger
                .info`drop update from ${peerInfo.name}: loop detected in path [${nodePath.join(', ')}]`
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
        this.logger.warn`unknown action: ${action.action}`
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
      this.logger.info`no GraphQL routes to sync`
      return
    }

    this.logger.info`syncing ${graphqlRoutes.length} GraphQL routes to gateway`

    const start = performance.now()
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
          this.gatewaySyncDuration.record((performance.now() - start) / 1000, {
            success: 'false',
          })
        } else {
          this.logger.info`Gateway sync successful`
          this.gatewaySyncDuration.record((performance.now() - start) / 1000, {
            success: 'true',
          })
        }
      }
    } catch (e) {
      this.logger.error`Error syncing to gateway: ${e}`
      this.gatewaySyncDuration.record((performance.now() - start) / 1000, { success: 'false' })
    }
  }

  async handleBGPNotify(action: Action, _state: RouteTable, prevState: RouteTable): Promise<void> {
    switch (action.action) {
      case Actions.LocalPeerCreate: {
        // Perform side effect: Try to open connection
        try {
          this.logger.info`attempting connection to ${action.data.name} at ${action.data.endpoint}`
          const stub = this.connectionPool.get(action.data.endpoint)
          if (stub) {
            // Use peer-specific token if available, otherwise fall back to node token
            const token = action.data.peerToken || this.nodeToken || ''
            const connectionResult = await stub.getIBGPClient(token)

            if (connectionResult.success) {
              const result = await connectionResult.client.open(this.config.node)

              if (result.success) {
                this.logger.info`successfully opened connection to ${action.data.name}`
                this.peerEvents.add(1, { event: 'connected' })
                // Dispatch connected action
                await this.dispatch({
                  action: Actions.InternalProtocolConnected,
                  data: { peerInfo: action.data },
                })
              }
            } else {
              this.logger.error`failed to get peer connection: ${connectionResult.error}`
              this.peerEvents.add(1, { event: 'failed' })
            }
          }
        } catch (e) {
          // Connection failed, leave as initializing (or could transition to error state)
          this.logger.error`failed to open connection to ${action.data.name}: ${e}`
          this.peerEvents.add(1, { event: 'failed' })
        }
        break
      }
      case Actions.InternalProtocolOpen: {
        this.logger.info`sync request from ${action.data.peerInfo.name}`
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
            this.logger.error`failed to sync routes back to ${action.data.peerInfo.name}: ${e}`
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
            this.logger.error`failed to sync routes to ${action.data.peerInfo.name}: ${e}`
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
            this.logger.error`failed to close connection to ${peer.name}: ${e}`
          }
        }

        this.peerEvents.add(1, { event: 'disconnected' })

        // 2. Propagate removal of routes learned FROM this peer to OTHER peers
        await this.propagateWithdrawalsForPeer(action.data.name, prevState, _state)
        break
      }
      case Actions.LocalRouteCreate: {
        // Broadcast to all connected internal peers
        const connectedPeers = _state.internal.peers.filter(
          (p) => p.connectionStatus === 'connected'
        )
        this.logger.info`broadcasting ${action.data.name} to ${connectedPeers.length} peers`
        for (const peer of connectedPeers) {
          try {
            const stub = this.connectionPool.get(peer.endpoint)
            if (stub) {
              this.logger.info`pushing local route ${action.data.name} to ${peer.name}`
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
            this.logger.error`failed to broadcast route to ${peer.name}: ${e}`
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
            this.logger.error`failed to broadcast route removal to ${peer.name}: ${e}`
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
            this.logger.error`failed to propagate update to ${peer.name}: ${e}`
          }
        }
        break
      }
      case Actions.InternalProtocolClose: {
        this.peerEvents.add(1, { event: 'disconnected' })
        await this.propagateWithdrawalsForPeer(action.data.peerInfo.name, prevState, _state)
        break
      }
    }
  }

  /**
   * Handle side effects after state changes.
   */
  async handleNotify(action: Action, _state: RouteTable, prevState: RouteTable): Promise<void> {
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

    this.logger.info`propagating withdrawal of ${removedRoutes.length} routes from ${peerName}`

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
        this.logger.error`failed to propagate withdrawal to ${peer.name}: ${e}`
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
