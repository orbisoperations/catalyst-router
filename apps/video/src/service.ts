import { Hono } from 'hono'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import type { VideoConfig } from './config.js'
import { generateMediaMtxConfig, serializeMediaMtxConfig } from './mediamtx/config-generator.js'
import { ProcessManager } from './mediamtx/process-manager.js'
import { ControlApiClient } from './mediamtx/control-api-client.js'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface VideoStreamServiceOptions extends CatalystServiceOptions {
  videoConfig: VideoConfig
}

/**
 * Video streaming service that orchestrates MediaMTX as a sidecar process.
 *
 * Startup sequence: config → generate MediaMTX YAML → spawn MediaMTX → ready.
 * Shutdown sequence: stop process manager → cleanup.
 *
 * When CATALYST_VIDEO_ENABLED=false, the service starts in a no-op mode:
 * it registers its health endpoint but skips MediaMTX entirely.
 */
export class VideoStreamService extends CatalystService {
  readonly info = { name: 'video', version: '0.0.0' }
  readonly handler = new Hono()
  readonly videoConfig: VideoConfig
  private processManager?: ProcessManager
  private controlApiClient?: ControlApiClient
  private configPath?: string

  constructor(options: VideoStreamServiceOptions) {
    super(options)
    this.videoConfig = options.videoConfig
  }

  protected async onInitialize(): Promise<void> {
    this.handler.get('/', (c) => c.text('Catalyst Video Service is running.'))

    this.handler.get('/health', (c) => {
      const state = this.processManager?.state ?? 'disabled'
      const status = state === 'running' || state === 'disabled' ? 200 : 503
      return c.json({ status: state }, status)
    })

    if (!this.videoConfig.enabled) {
      this.telemetry.logger.info('Video streaming disabled (CATALYST_VIDEO_ENABLED=false)', {
        'event.name': 'video.service.disabled',
      })
      return
    }

    // Generate MediaMTX config YAML
    const servicePort = this.config.port
    const mtxConfig = generateMediaMtxConfig(this.videoConfig, servicePort)
    const yaml = serializeMediaMtxConfig(mtxConfig)

    const configDir = join(tmpdir(), 'catalyst-video')
    await mkdir(configDir, { recursive: true })
    this.configPath = join(configDir, 'mediamtx.yml')
    await writeFile(this.configPath, yaml, 'utf-8')

    this.telemetry.logger.debug('MediaMTX config generated', {
      'event.name': 'video.mediamtx.config_generated',
      configPath: this.configPath,
    })

    // Initialize Control API client
    this.controlApiClient = new ControlApiClient({
      baseUrl: `http://127.0.0.1:${this.videoConfig.apiPort}`,
    })

    // Start MediaMTX process
    this.processManager = new ProcessManager({
      binaryPath: process.env.MEDIAMTX_PATH ?? 'mediamtx',
      configPath: this.configPath,
    })

    this.processManager.on('started', (pid) => {
      this.telemetry.logger.info('MediaMTX process started (pid: {pid})', {
        'event.name': 'video.mediamtx.started',
        pid,
      })
    })

    this.processManager.on('exited', (exitCode, signal) => {
      this.telemetry.logger.warn('MediaMTX process exited (code: {exitCode})', {
        'event.name': 'video.mediamtx.exited',
        exitCode,
        signal,
      })
    })

    this.processManager.on('restarting', (attempt, maxAttempts) => {
      this.telemetry.logger.warn('Restarting MediaMTX (attempt {attempt}/{maxAttempts})', {
        'event.name': 'video.mediamtx.restarting',
        attempt,
        maxAttempts,
      })
    })

    this.processManager.on('degraded', () => {
      this.telemetry.logger.fatal('VideoStreamService degraded after restart failures', {
        'event.name': 'video.service.degraded',
      })
    })

    await this.processManager.start()

    this.telemetry.logger.info('VideoStreamService started on {nodeId}', {
      'event.name': 'video.service.started',
      nodeId: this.config.node.name,
    })
  }

  protected async onShutdown(): Promise<void> {
    await this.processManager?.stop()

    this.telemetry.logger.info('VideoStreamService stopped', {
      'event.name': 'video.service.stopped',
      reason: 'shutdown',
    })
  }

  /** Expose control API client for lifecycle hooks and relay manager. */
  getControlApiClient(): ControlApiClient | undefined {
    return this.controlApiClient
  }

  /** Expose process manager state for health checks. */
  getProcessState(): string {
    return this.processManager?.state ?? 'disabled'
  }

  static async create<T extends CatalystService>(
    this: new (options: VideoStreamServiceOptions) => T,
    options: VideoStreamServiceOptions
  ): Promise<T> {
    const instance = new this(options)
    await instance.initialize()
    return instance
  }
}
