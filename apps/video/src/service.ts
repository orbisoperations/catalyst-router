import { Hono } from 'hono'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import { StreamState } from './state/stream-state.js'
import { VideoRpcServer, createRpcHandler } from './rpc/server.js'
import { createStreamsRouter } from './routes/streams.js'
import type { MediaRouteConfig, UpdateResult } from './types.js'

export class VideoService extends CatalystService {
  readonly info = { name: 'video', version: '0.0.0' }
  readonly handler = new Hono()
  private streamState = new StreamState()

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  protected async onInitialize(): Promise<void> {
    const rpcServer = new VideoRpcServer(
      (config) => this.handleMediaRouteUpdate(config),
      this.streamState
    )
    const instrumentedRpc = this.telemetry.instrumentRpc(rpcServer)
    const rpcApp = createRpcHandler(instrumentedRpc)

    const streamsRouter = createStreamsRouter(this.streamState)

    this.handler.route('/api', rpcApp)
    this.handler.route('/video-stream', streamsRouter)
  }

  private async handleMediaRouteUpdate(config: MediaRouteConfig): Promise<UpdateResult> {
    this.telemetry.logger.info`Received ${config.routes.length} remote media routes`
    this.streamState.setRemote(config.routes)
    // Phase 5: relay reconciliation will be wired here
    return { success: true }
  }

  protected async onShutdown(): Promise<void> {
    // Phase 3: stop MediaMTX process
  }
}
