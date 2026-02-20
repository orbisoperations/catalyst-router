import {
  Actions,
  type Action,
  type DataChannelDefinition,
  type InternalRoute,
  type PeerInfo,
  type RouteTable,
} from '@catalyst/routing'
export type { PeerInfo, InternalRoute }
import { getLogger } from '@catalyst/telemetry'
import { type OrchestratorConfig, OrchestratorConfigSchema } from './types.js'
import { createPortAllocator, type PortAllocator } from '@catalyst/envoy-service'
import { newWebSocketRpcSession, type RpcStub, RpcTarget } from 'capnweb'
import { PeerTransport } from './peer-transport.js'
import type { PublicApi, UpdateMessage } from './api-types.js'
import { ActionQueue, type DispatchResult } from './action-queue.js'
import { RoutingInformationBase, type CommitResult } from './rib.js'
import { ConnectionPool } from './connection-pool.js'

// Re-export for backward compatibility (tests, peer-transport, etc.)
export { ConnectionPool } from './connection-pool.js'
export { getHttpPeerSession, getWebSocketPeerSession } from './connection-pool.js'

export type { PublicApi, NetworkClient, DataChannel, IBGPClient } from './api-types.js'

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
  private connectionPool: ConnectionPool
  private peerTransport: PeerTransport
  private config: OrchestratorConfig
  private authClient?: RpcStub<AuthServiceApi>
  private portAllocator?: PortAllocator
  private rib: RoutingInformationBase
  private queue: ActionQueue
  private tickTimer?: ReturnType<typeof setInterval>
  public lastNotificationPromise?: Promise<PostCommitOutcome>

  constructor(opts: {
    state?: RouteTable
    connectionPool?: { type?: 'ws' | 'http'; pool?: ConnectionPool }
    config: OrchestratorConfig
    nodeToken?: string
    authEndpoint?: string
  }) {
    super()
    const parsedConfig = OrchestratorConfigSchema.safeParse(opts.config)
    if (!parsedConfig.success) {
      throw new Error(
        `Invalid CatalystNodeBus config: ${parsedConfig.error.issues.map((a) => a.message).join(', ')}`
      )
    }
    this.config = opts.config
    if (opts.authEndpoint) {
      this.authClient = newWebSocketRpcSession<AuthServiceApi>(opts.authEndpoint)
    }
    this.connectionPool =
      opts.connectionPool?.pool ??
      (opts.connectionPool?.type
        ? new ConnectionPool(opts.connectionPool.type)
        : new ConnectionPool())

    this.peerTransport = new PeerTransport(this.connectionPool, opts.nodeToken)

    if (this.config.envoyConfig?.portRange) {
      this.portAllocator = createPortAllocator(this.config.envoyConfig.portRange)
    }

    this.rib = new RoutingInformationBase(this.config, this.portAllocator, opts.state)

    this.validateNodeConfig()
    this.queue = new ActionQueue((action) => this.pipeline(action))
  }

  /** Expose state for tests that read it via casting */
  private get state(): RouteTable {
    return this.rib.getState()
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

  startTick(): void {
    if (this.tickTimer) return
    const intervalMs = this.computeTickInterval()
    this.logger.info`Starting keepalive tick (interval: ${intervalMs}ms)`
    this.tickTimer = setInterval(() => {
      this.dispatch({ action: Actions.Tick, data: { now: Date.now() } }).catch((e) => {
        this.logger.error`Tick dispatch failed: ${e}`
      })
    }, intervalMs)
  }

  stopTick(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = undefined
    }
  }

  shutdown(): void {
    this.stopTick()
  }

  private computeTickInterval(): number {
    const peers = this.rib.getState().internal.peers
    const holdTimes = peers
      .filter((p) => p.connectionStatus === 'connected' && p.holdTime != null)
      .map((p) => p.holdTime!)

    if (holdTimes.length === 0) return 30_000

    const minHoldTime = Math.min(...holdTimes)
    return Math.max(1000, (minHoldTime / 6) * 1000)
  }

  private async validateToken(
    callerToken: string,
    action: string
  ): Promise<{ valid: true } | { valid: false; error: string }> {
    if (!this.authClient) {
      return { valid: true }
    }

    try {
      const permissionsApi = await this.authClient.permissions(callerToken)
      if ('error' in permissionsApi) {
        return { valid: false, error: `Invalid token: ${permissionsApi.error}` }
      }

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

    if (sentAction.action === Actions.LocalRouteCreate) {
      this.logger.debug`Route create data: ${JSON.stringify(sentAction.data)}`
    }

    const plan = this.rib.plan(sentAction)
    if (!plan.success) {
      this.logger.error`Action failed: ${sentAction.action} - ${plan.error}`
      return plan
    }

    const commitResult = this.rib.commit(plan)

    this.lastNotificationPromise = this.handlePostCommit(sentAction, commitResult).catch((e) => {
      this.logger.error`Error in post-commit for ${sentAction.action}: ${e}`
    })

    return { success: true }
  }

  private async handlePostCommit(sentAction: Action, commitResult: CommitResult): Promise<void> {
    const peerResults = await this.peerTransport.fanOut(commitResult.propagations)

    if (sentAction.action === Actions.LocalPeerCreate) {
      const openSucceeded = peerResults.some((r) => r.status === 'fulfilled')
      if (openSucceeded) {
        this.logger.info`Successfully opened connection to ${sentAction.data.name}`
        await this.dispatch({
          action: Actions.InternalProtocolConnected,
          data: { peerInfo: sentAction.data },
        })
      }
    }

    await this.syncEnvoy(sentAction)
    await this.syncGraphql()
  }

  private async syncEnvoy(action: Action): Promise<void> {
    const envoyEndpoint = this.config.envoyConfig?.endpoint
    if (!envoyEndpoint || !this.portAllocator) return

    const routeActions = [
      Actions.LocalRouteCreate,
      Actions.LocalRouteDelete,
      Actions.InternalProtocolUpdate,
      Actions.InternalProtocolClose,
      Actions.InternalProtocolOpen,
      Actions.InternalProtocolConnected,
    ]
    if (!routeActions.includes(action.action)) return

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

  private async syncGraphql(): Promise<void> {
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
      const result = await stub.updateConfig({
        services: graphqlRoutes.map((r) => ({ name: r.name, url: r.endpoint! })),
      })
      if (!result.success) {
        this.logger.error`Gateway sync failed: ${result.error}`
      } else {
        this.logger.info`Gateway sync successful`
      }
    } catch (e) {
      this.logger.error`Error syncing to gateway: ${e}`
    }
  }

  publicApi(): PublicApi {
    return {
      getNetworkClient: async (token: string) => {
        const validation = await this.validateToken(token, 'PEER_CREATE')
        if (!validation.valid) return { success: false as const, error: validation.error }

        return {
          success: true as const,
          client: {
            addPeer: (peer: PeerInfo) =>
              this.dispatch({ action: Actions.LocalPeerCreate, data: peer }),
            updatePeer: (peer: PeerInfo) =>
              this.dispatch({ action: Actions.LocalPeerUpdate, data: peer }),
            removePeer: (peer: Pick<PeerInfo, 'name'>) =>
              this.dispatch({ action: Actions.LocalPeerDelete, data: peer }),
            listPeers: async () => this.rib.getState().internal.peers,
          },
        }
      },
      getDataChannelClient: async (token: string) => {
        const validation = await this.validateToken(token, 'ROUTE_CREATE')
        if (!validation.valid) return { success: false as const, error: validation.error }

        return {
          success: true as const,
          client: {
            addRoute: (route: DataChannelDefinition) =>
              this.dispatch({ action: Actions.LocalRouteCreate, data: route }),
            removeRoute: (route: DataChannelDefinition) =>
              this.dispatch({ action: Actions.LocalRouteDelete, data: route }),
            listRoutes: async () => ({
              local: this.rib.getState().local.routes,
              internal: this.rib.getState().internal.routes,
            }),
          },
        }
      },
      getIBGPClient: async (token: string) => {
        const validation = await this.validateToken(token, 'IBGP_CONNECT')
        if (!validation.valid) return { success: false as const, error: validation.error }

        return {
          success: true as const,
          client: {
            open: (peer: PeerInfo) =>
              this.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peer } }),
            close: (peer: PeerInfo, code: number, reason?: string) =>
              this.dispatch({
                action: Actions.InternalProtocolClose,
                data: { peerInfo: peer, code, reason },
              }),
            update: (peer: PeerInfo, update: UpdateMessage) =>
              this.dispatch({
                action: Actions.InternalProtocolUpdate,
                data: { peerInfo: peer, update },
              }),
          },
        }
      },
      dispatch: (action: Action) => this.dispatch(action),
    }
  }
}
