import { Hono } from 'hono'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import { StreamState } from './state/stream-state.js'
import { VideoRpcServer, createRpcHandler } from './rpc/server.js'
import { createStreamsRouter } from './routes/streams.js'
import { createHooksRouter } from './hooks/ready.js'
import { generateMediaMTXConfig, writeMediaMTXConfig } from './media/config-writer.js'
import { MediaProcessManager } from './media/manager.js'
import { MediaMTXProcess } from './media/process.js'
import { createAuthRouter } from './hooks/auth.js'
import { HttpMediaServerClient } from './media/client.js'
import { RelayManager } from './relay/relay-manager.js'
import type { MediaRouteConfig, UpdateResult } from './types.js'

export class VideoService extends CatalystService {
  readonly info = { name: 'video', version: '0.0.0' }
  readonly handler = new Hono()
  private streamState = new StreamState()
  private processManager: MediaProcessManager | null = null
  private relayManager: RelayManager | null = null

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
    const hooksRouter = createHooksRouter({
      nodeName: this.config.node.name,
      rtspPort: this.config.video?.rtspPort ?? 8554,
      onReady: async (route) => {
        this.telemetry.logger.info`Stream ready: ${route.name}`
        this.streamState.addLocal(route.name, route.endpoint, [])
        // TODO: dispatch LocalRouteCreate to orchestrator
      },
      onNotReady: async (route) => {
        this.telemetry.logger.info`Stream not ready: ${route.name}`
        this.streamState.removeLocal(route.name)
        // TODO: dispatch LocalRouteDelete to orchestrator
      },
    })
    const authRouter = createAuthRouter({
      authFailPublish: this.config.video?.authFailPublish ?? 'closed',
      authFailSubscribe: this.config.video?.authFailSubscribe ?? 'closed',
    })

    this.handler.route('/api', rpcApp)
    this.handler.route('/video-stream', streamsRouter)
    this.handler.route('/video-stream/hooks', hooksRouter)
    this.handler.route('/video-stream', authRouter)

    if (this.config.video?.enabled) {
      const yaml = generateMediaMTXConfig(this.config.video, this.config.port)
      const configPath = writeMediaMTXConfig(yaml)
      const process = new MediaMTXProcess(configPath)
      this.processManager = new MediaProcessManager(process)
      await this.processManager.start()
      this.telemetry.logger.info`MediaMTX started with config at ${configPath}`

      const mediaClient = new HttpMediaServerClient('http://localhost:9997')
      this.relayManager = new RelayManager(mediaClient)
    }
  }

  private async handleMediaRouteUpdate(config: MediaRouteConfig): Promise<UpdateResult> {
    this.telemetry.logger.info`Received ${config.routes.length} remote media routes`
    this.streamState.setRemote(config.routes)

    if (this.relayManager) {
      await this.relayManager.reconcile(config.routes)
    }

    return { success: true }
  }

  protected async onShutdown(): Promise<void> {
    if (this.processManager?.isRunning()) {
      await this.processManager.stop()
    }
  }
}
