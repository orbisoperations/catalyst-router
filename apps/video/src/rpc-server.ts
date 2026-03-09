import { RpcTarget } from 'capnweb'
import { getLogger } from '@catalyst/telemetry'

import type { VideoBusClient, StreamCatalog, DispatchCapability } from './bus-client.js'

const logger = getLogger(['video', 'rpc'])

/**
 * Callbacks injected by the service layer so the RPC server can
 * drive lifecycle state without owning it directly.
 */
export interface VideoRpcServerDeps {
  busClient: VideoBusClient
  /** Called when a new catalog is pushed; triggers reconciliation. */
  onCatalogUpdate?: (catalog: StreamCatalog) => Promise<void>
  /** Called on first catalog push — marks the service ready. */
  onCatalogReady?: () => void
  /** Called when orchestrator disconnects — marks catalog lost. */
  onCatalogLost?: () => void
  /** Called when orchestrator pushes a refreshed auth token. */
  onTokenRefresh?: (token: string) => Promise<void>
}

/**
 * RPC target exposed at the video service's `/api` WebSocket endpoint.
 *
 * Implements a progressive API pattern: the orchestrator calls
 * `getVideoClient(dispatch)`, passing its dispatch capability, and receives
 * back `{ updateStreamCatalog, refreshToken }` capabilities it can call.
 */
export class VideoRpcServer extends RpcTarget {
  private readonly deps: VideoRpcServerDeps
  private catalogReceived = false
  /** Incremented on each connect/disconnect to detect stale async callbacks. */
  private connectionGeneration = 0

  constructor(deps: VideoRpcServerDeps) {
    super()
    this.deps = deps
  }

  /**
   * Factory method called by the orchestrator after connecting.
   *
   * The orchestrator passes its `dispatch` capability so the video service
   * can forward actions (subscribe/unsubscribe) back to the orchestrator bus.
   * In return, the orchestrator receives capabilities to push catalog updates
   * and refresh the video service's auth token.
   */
  async getVideoClient(dispatchCapability: DispatchCapability): Promise<{
    success: true
    client: {
      updateStreamCatalog: (catalog: StreamCatalog) => Promise<void>
      refreshToken: (token: string) => Promise<void>
    }
  }> {
    this.connectionGeneration++
    const generation = this.connectionGeneration

    logger.info`Orchestrator connected — storing dispatch capability (gen=${generation})`
    this.deps.busClient.setDispatch(dispatchCapability)

    return {
      success: true,
      client: {
        updateStreamCatalog: async (catalog: StreamCatalog): Promise<void> => {
          const streams = catalog?.streams ?? []
          logger.info`Catalog update received: ${streams.length} streams`
          this.deps.busClient.setCatalog({ streams })

          if (this.deps.onCatalogUpdate) {
            await this.deps.onCatalogUpdate({ streams })
          }

          // Guard: if disconnected while onCatalogUpdate was running, don't mark ready
          if (generation !== this.connectionGeneration) {
            logger.info`Catalog update completed but connection generation changed (${generation} → ${this.connectionGeneration}), skipping ready`
            return
          }

          if (!this.catalogReceived) {
            this.catalogReceived = true
            logger.info`First catalog received — marking catalog ready`
            this.deps.onCatalogReady?.()
          }
        },

        refreshToken: async (token: string): Promise<void> => {
          logger.info`Token refresh received`
          if (this.deps.onTokenRefresh) {
            await this.deps.onTokenRefresh(token)
          }
        },
      },
    }
  }

  /**
   * Called when the orchestrator WebSocket connection closes.
   * Clears the dispatch capability and resets catalog readiness.
   */
  handleDisconnect(): void {
    this.connectionGeneration++
    logger.info`Orchestrator disconnected — clearing dispatch capability (gen=${this.connectionGeneration})`
    this.deps.busClient.clearDispatch()
    this.catalogReceived = false
    this.deps.onCatalogLost?.()
  }
}
