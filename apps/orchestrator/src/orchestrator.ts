import {
  Actions,
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
import { PeerTransport } from './peer-transport.js'
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
import { RoutingInformationBase, type CommitResult } from './rib.js'

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
  private connectionPool: ConnectionPool
  private peerTransport: PeerTransport
  private config: OrchestratorConfig
  private nodeToken?: string
  private authClient?: RpcStub<AuthServiceApi>
  private portAllocator?: PortAllocator
  private rib: RoutingInformationBase
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

  /**
   * Validates an incoming caller token using the auth service permissions API.
   */
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

    // 1. Plan: compute new state + propagations (does not mutate RIB state)
    const plan = this.rib.plan(sentAction)
    if (!plan.success) {
      this.logger.error`Action failed: ${sentAction.action} - ${plan.error}`
      return plan
    }

    // 2. Commit: apply state atomically (synchronous)
    const commitResult = this.rib.commit(plan)

    // 3. Post-commit side effects (fire-and-forget to avoid ActionQueue deadlock)
    this.lastNotificationPromise = this.handlePostCommit(sentAction, commitResult).catch((e) => {
      this.logger.error`Error in post-commit for ${sentAction.action}: ${e}`
    })

    return { success: true }
  }

  private async handlePostCommit(sentAction: Action, commitResult: CommitResult): Promise<void> {
    // Execute propagations (peer transport)
    const peerResults = await this.peerTransport.fanOut(commitResult.propagations)

    // LocalPeerCreate: if open succeeded, trigger InternalProtocolConnected
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

    // Infrastructure side effects (envoy + graphql)
    await this.handleEnvoyPush(sentAction, commitResult.newState, commitResult.prevState)
    await this.handleGraphqlConfiguration()
  }

  private async handleEnvoyPush(
    action: Action,
    _state: RouteTable,
    _prevState: RouteTable
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

    // Push complete config to envoy service
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

  private async handleGraphqlConfiguration(): Promise<void> {
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

  publicApi(): PublicApi {
    return {
      getNetworkClient: async (
        token: string
      ): Promise<{ success: true; client: NetworkClient } | { success: false; error: string }> => {
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
