import { Hono } from 'hono'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import type { VideoConfig } from './config.js'
import { generateMediaMtxConfig, serializeMediaMtxConfig } from './mediamtx/config-generator.js'
import { ProcessManager } from './mediamtx/process-manager.js'
import { ControlApiClient } from './mediamtx/control-api-client.js'
import { createAuthHook } from './hooks/auth.js'
import { createLifecycleHooks } from './hooks/lifecycle.js'
import { StreamRouteManager } from './routes/stream-route-manager.js'
import { ReconnectingClient } from './rpc/reconnecting-client.js'
import { TokenRefreshScheduler } from './rpc/token-refresh.js'
import { RelayManager } from './routes/relay-manager.js'
import { newWebSocketRpcSession } from 'capnweb'
import { decodeJwt } from 'jose'
import type { DataChannelDefinition, InternalRoute, RouteChange } from '@catalyst/routing/v2'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface VideoStreamServiceOptions extends CatalystServiceOptions {
  videoConfig: VideoConfig
}

interface AuthRpcApi {
  tokens(token: string): Promise<
    | {
        create(request: {
          subject: string
          entity: {
            id: string
            name: string
            type: 'user' | 'service'
            nodeId?: string
            trustedNodes?: string[]
            trustedDomains?: string[]
          }
          principal: string
          expiresIn?: string
        }): Promise<string>
      }
    | { error: string }
  >
}

interface OrchestratorPublicApi {
  getDataChannelClient(
    token: string
  ): Promise<{ success: true; client: DataChannel } | { success: false; error: string }>
}

interface DataChannel {
  addRoute(
    route: DataChannelDefinition
  ): Promise<{ success: true } | { success: false; error: string }>
  removeRoute(
    route: Pick<DataChannelDefinition, 'name'>
  ): Promise<{ success: true } | { success: false; error: string }>
  listRoutes(): Promise<{ local: DataChannelDefinition[]; internal: InternalRoute[] }>
  watchRoutes(callback: (changes: RouteChange[]) => void): () => void
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
  private routeManager?: StreamRouteManager
  private configPath?: string
  private rpcClient?: ReconnectingClient
  private tokenScheduler?: TokenRefreshScheduler
  private relayManager?: RelayManager
  private currentToken?: string
  private dataChannel?: DataChannel

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

    // Wire auth hook — stub token validator and Cedar evaluator for now
    const domainId = this.config.node.domains?.[0] ?? 'default'
    const authHook = createAuthHook({
      tokenValidator: {
        validate: async (token) => {
          try {
            const authBase = this.videoConfig.authEndpoint.replace(/^ws/, 'http')
            const res = await fetch(`${authBase}/verify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token }),
            })
            if (!res.ok) return { valid: false, error: 'invalid_token' }
            const payload = (await res.json()) as Record<string, unknown>
            return { valid: true, payload }
          } catch {
            return { valid: false, error: 'auth_service_unreachable' }
          }
        },
      },
      streamAccess: { evaluate: () => 'allow' },
      nodeId: this.config.node.name,
      domainId,
    })
    this.handler.route('/', authHook)

    // Wire lifecycle hooks with route manager — registrar delegates to DataChannel
    this.routeManager = new StreamRouteManager({
      registrar: {
        addRoute: async (route) => {
          if (!this.dataChannel) throw new Error('Not connected to orchestrator')
          const result = await this.dataChannel.addRoute(route)
          if (!result.success) throw new Error(result.error)
        },
        removeRoute: async (name) => {
          if (!this.dataChannel) throw new Error('Not connected to orchestrator')
          const result = await this.dataChannel.removeRoute({ name })
          if (!result.success) throw new Error(result.error)
        },
      },
      metadataProvider: { getPathMetadata: async () => null },
      advertiseAddress: this.videoConfig.advertiseAddress ?? 'localhost',
      rtspPort: this.videoConfig.rtspPort,
      maxStreams: this.videoConfig.maxStreams,
    })
    const lifecycleHooks = createLifecycleHooks({ routeManager: this.routeManager })
    this.handler.route('/', lifecycleHooks)

    // Wire RelayManager — RouteSubscription delegates to DataChannel
    this.relayManager = new RelayManager({
      routeSource: {
        watchRoutes: (cb) => {
          if (!this.dataChannel) throw new Error('Not connected to orchestrator')
          return this.dataChannel.watchRoutes(cb)
        },
        listRoutes: () => {
          if (!this.dataChannel) throw new Error('Not connected to orchestrator')
          return this.dataChannel.listRoutes()
        },
      },
      controlApi: this.controlApiClient!,
      localNodeName: this.config.node.name,
      getRelayToken: () => this.currentToken!,
    })

    // Token minting — connect to auth service for DATA_CUSTODIAN token
    const mintToken = async (): Promise<string> => {
      const authClient = newWebSocketRpcSession<AuthRpcApi>(this.videoConfig.authEndpoint)
      const tokensApi = await authClient.tokens(this.videoConfig.systemToken)

      if ('error' in tokensApi) {
        throw new Error(`Failed to access tokens API: ${tokensApi.error}`)
      }

      const token = await tokensApi.create({
        subject: this.config.node.name,
        entity: {
          id: this.config.node.name,
          name: this.config.node.name,
          type: 'service',
          nodeId: this.config.node.name,
          trustedNodes: [this.config.node.name],
          trustedDomains: this.config.node.domains,
        },
        principal: 'CATALYST::DATA_CUSTODIAN',
        expiresIn: '7d',
      })

      this.currentToken = token
      return token
    }

    // DataChannel connection — connect to orchestrator PublicApi
    const connectToOrchestrator = async (): Promise<DataChannel> => {
      const stub = newWebSocketRpcSession<OrchestratorPublicApi>(
        this.videoConfig.orchestratorEndpoint
      )
      const result = await stub.getDataChannelClient(this.currentToken!)
      if (!result.success) {
        throw new Error(`DataChannel auth failed: ${result.error}`)
      }
      this.dataChannel = result.client
      return result.client
    }

    // ReconnectingClient lifecycle: mintToken → connect → relayManager.start → reconcile
    this.rpcClient = new ReconnectingClient({
      mintToken,
      connect: async () => {
        const dc = await connectToOrchestrator()
        await this.relayManager!.start()
        return dc
      },
      reconcile: async () => {
        await this.relayManager!.reconcile()
      },
    })

    this.rpcClient.on('connected', () => {
      this.telemetry.logger.info('Connected to orchestrator', {
        'event.name': 'video.rpc.connected',
      })
    })

    this.rpcClient.on('disconnected', () => {
      this.telemetry.logger.warn('Disconnected from orchestrator', {
        'event.name': 'video.rpc.disconnected',
      })
    })

    this.rpcClient.on('reconnecting', (attempt, delay) => {
      this.telemetry.logger.info(
        'Reconnecting to orchestrator (attempt {attempt}, delay {delay}ms)',
        {
          'event.name': 'video.rpc.reconnecting',
          attempt,
          delay,
        }
      )
    })

    this.rpcClient.on('error', (err) => {
      this.telemetry.logger.error('RPC client error: {error}', {
        'event.name': 'video.rpc.error',
        error: err.message,
      })
    })

    // TokenRefreshScheduler — hourly check, refresh at 80% TTL
    this.tokenScheduler = new TokenRefreshScheduler({
      getExpiry: () => {
        if (!this.currentToken) return undefined
        const { exp } = decodeJwt(this.currentToken)
        return exp ? exp * 1000 : undefined
      },
      getIssuedAt: () => {
        if (!this.currentToken) return undefined
        const { iat } = decodeJwt(this.currentToken)
        return iat ? iat * 1000 : undefined
      },
      refresh: async () => {
        const token = await mintToken()
        const { exp } = decodeJwt(token)
        return (exp ?? 0) * 1000
      },
    })

    // Start RPC connection (non-blocking — retries on failure)
    this.rpcClient.start().catch((err) => {
      this.telemetry.logger.error('Initial RPC connection failed, will retry: {error}', {
        'event.name': 'video.rpc.initial_connect_failed',
        error: err instanceof Error ? err.message : String(err),
      })
    })

    this.tokenScheduler.start()

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
    this.tokenScheduler?.stop()
    this.relayManager?.shutdown()
    this.rpcClient?.stop()
    this.routeManager?.shutdown()
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
