import { RpcTarget } from 'capnweb'
import type {
  Action,
  ListLocalRoutesResult,
  ListMetricsResult,
  ApplyActionResult,
} from './schema/index.js'
import type { RouteTable } from '../state/route-table.js'
import { GlobalRouteTable } from '../state/route-table.js'
import type { PluginInterface } from '../plugins/types.js'
import { PluginPipeline } from '../plugins/pipeline.js'
import { LoggerPlugin } from '../plugins/implementations/logger.js'
import { GatewayIntegrationPlugin } from '../plugins/implementations/gateway.js'
import { LocalRoutingTablePlugin } from '../plugins/implementations/local-routing.js'
import { InternalBGPPlugin } from '../plugins/implementations/Internal-bgp.js'
import type { ListPeersResult, PeerInfo, UpdateMessage, IBGPScope } from './schema/peering.js'
import {
  IBGPProtocolResource,
  IBGPProtocolResourceAction,
  IBGPConfigResource,
  IBGPConfigResourceAction,
} from './schema/peering.js'
import type { OrchestratorConfig } from '../config.js'
import { getConfig } from '../config.js'
import { getHttpPeerSession, getWebSocketPeerSession } from './client.js'

export class OrchestratorRpcServer extends RpcTarget {
  private pipeline: PluginPipeline
  private state: RouteTable
  private config: OrchestratorConfig

  constructor(config?: OrchestratorConfig) {
    super()
    this.config = config || getConfig()

    // Initialize State with GlobalRouteTable (empty/initial)
    this.state = GlobalRouteTable

    // Initialize Plugins
    const plugins: PluginInterface[] = [new LoggerPlugin()]

    // Conditionally add Gateway Plugin
    if (this.config.gqlGatewayConfig) {
      plugins.push(
        new GatewayIntegrationPlugin(this.config.gqlGatewayConfig, {
          triggerOnResources: ['localRoute'],
        })
      )
    }

    // Initialize plugins
    const routingPlugin = new LocalRoutingTablePlugin()

    const sessionFactory =
      this.config.ibgp.transport === 'websocket' ? getWebSocketPeerSession : getHttpPeerSession

    if (this.config.ibgp.transport === 'websocket') {
      console.log('[Orchestrator] Using WebSocket transport for iBGP')
    }

    const internalBgpPlugin = new InternalBGPPlugin(sessionFactory)

    this.pipeline = new PluginPipeline(
      [routingPlugin, internalBgpPlugin, ...plugins],
      'OrchestratorPipeline'
    )
  }

  /*
    // V2 MIGRATION NOTE:
    // The architecture is moving towards a split State/Notification pipeline.
    // The integration would look like this:
    
    // import { OrchestratorV2 } from '../next/orchestrator.js';
    // const v2 = new OrchestratorV2();
    // return v2; 
    
    // For now, this class maintains the V1 PluginPipeline compatibility.
    */

  async connectionFromManagementSDK(): Promise<ManagementScope> {
    return new ManagementRpcScope(this)
  }

  async createPeer(endpoint: string, domains?: string[]): Promise<ApplyActionResult> {
    const action: Action = {
      resource: IBGPConfigResource.value,
      resourceAction: IBGPConfigResourceAction.enum.create,
      data: { endpoint, domains },
    }
    return this.applyAction(action)
  }

  async updatePeer(
    peerId: string,
    endpoint: string,
    domains?: string[]
  ): Promise<ApplyActionResult> {
    const action: Action = {
      resource: IBGPConfigResource.value,
      resourceAction: IBGPConfigResourceAction.enum.update,
      data: { peerId, endpoint, domains },
    }
    return this.applyAction(action)
  }

  async deletePeer(peerId: string): Promise<ApplyActionResult> {
    const action: Action = {
      resource: IBGPConfigResource.value,
      resourceAction: IBGPConfigResourceAction.enum.delete,
      data: { peerId },
    }
    return this.applyAction(action)
  }

  async connectToIBGPPeer(secret: string): Promise<IBGPScope> {
    if (this.config.as === 0) {
      throw new Error('This node is not configured for iBGP')
    }
    if (secret !== this.config.ibgp.secret) {
      throw new Error('Invalid secret')
    }

    return {
      open: async (peerInfo: PeerInfo) => {
        console.log(`[iBGP] Peer connected: ${peerInfo.id} (AS ${peerInfo.as})`)

        // If new, register via pipeline
        // The plugin will handle the reverse connection
        const action: Action = {
          resource: IBGPProtocolResource.value,
          resourceAction: IBGPProtocolResourceAction.enum.open,
          data: {
            peerInfo,
          },
        }

        const result = await this.applyAction(action)

        if (!result.success) {
          return {
            success: false,
            error: result.error,
          }
        }

        // Return our local PeerInfo so the initiator knows who we are
        const myConfig = this.config
        const myPeerInfo: PeerInfo = {
          id: myConfig.ibgp.localId || 'unknown',
          as: myConfig.as,
          endpoint: myConfig.ibgp.endpoint || 'unknown',
          domains: myConfig.ibgp.domains,
        }

        return {
          success: true,
          peerInfo: myPeerInfo,
        }
      },
      update: async (peerInfo: PeerInfo, routes: UpdateMessage[]) => {
        const action: Action = {
          resource: IBGPProtocolResource.value,
          resourceAction: IBGPProtocolResourceAction.enum.update,
          data: {
            peerInfo: peerInfo,
            updateMessages: routes,
          },
        }

        return this.applyAction(action)
      },
      close: async (peerInfo: Omit<PeerInfo, 'domains'>) => {
        const action: Action = {
          resource: IBGPProtocolResource.value,
          resourceAction: IBGPProtocolResourceAction.enum.close,
          data: {
            peerInfo: peerInfo as unknown as PeerInfo,
          },
        }

        return this.applyAction(action)
      },
    }
  }

  private actionLock: Promise<unknown> = Promise.resolve()

  async applyAction(action: Action): Promise<ApplyActionResult> {
    const resultPromise = this.actionLock.then(async () => {
      try {
        const result = await this.pipeline.apply({
          action,
          state: this.state,
          authxContext: { userId: 'stub-user', roles: ['admin'] }, // Stub auth context
          results: [],
        })

        if (!result.success) {
          return {
            success: false,
            error: result.error?.message || 'Unknown error',
          } as ApplyActionResult
        }

        // Update local state with the state returned from the pipeline
        this.state = result.ctx.state

        return {
          success: true,
          results: result.ctx.results,
        } as ApplyActionResult
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e)
        return { success: false, error: message } as ApplyActionResult
      }
    })

    this.actionLock = resultPromise.catch(() => {
      // Ignore lock errors to allow subsequent actions
    }) // Continue chain even on error
    return resultPromise
  }

  async listLocalRoutes(): Promise<ListLocalRoutesResult> {
    const routes = this.state.getRoutes()
    return { routes }
  }

  async listMetrics(): Promise<ListMetricsResult> {
    const metrics = this.state.getMetrics()
    return { metrics }
  }

  // ----------------------------------------------------------------
  // Peer Public API Implementation
  // ----------------------------------------------------------------

  async listPeers(): Promise<ListPeersResult> {
    const peers = this.state.getPeers()
    return { peers }
  }
}

export interface ManagementScope {
  applyAction(action: Action): Promise<ApplyActionResult>
  listLocalRoutes(): Promise<ListLocalRoutesResult>
  listMetrics(): Promise<ListMetricsResult>
  listPeers(): Promise<ListPeersResult>
  createPeer(endpoint: string, domains?: string[]): Promise<ApplyActionResult>
  updatePeer(peerId: string, endpoint: string, domains?: string[]): Promise<ApplyActionResult>
  deletePeer(peerId: string): Promise<ApplyActionResult>
}

export class ManagementRpcScope extends RpcTarget implements ManagementScope {
  constructor(private server: OrchestratorRpcServer) {
    super()
  }

  async applyAction(action: Action): Promise<ApplyActionResult> {
    return this.server.applyAction(action)
  }

  async listLocalRoutes(): Promise<ListLocalRoutesResult> {
    return this.server.listLocalRoutes()
  }

  async listMetrics(): Promise<ListMetricsResult> {
    return this.server.listMetrics()
  }

  async listPeers(): Promise<ListPeersResult> {
    return this.server.listPeers()
  }

  async createPeer(endpoint: string, domains?: string[]): Promise<ApplyActionResult> {
    return this.server.createPeer(endpoint, domains)
  }

  async updatePeer(
    peerId: string,
    endpoint: string,
    domains?: string[]
  ): Promise<ApplyActionResult> {
    return this.server.updatePeer(peerId, endpoint, domains)
  }

  async deletePeer(peerId: string): Promise<ApplyActionResult> {
    return this.server.deletePeer(peerId)
  }
}
