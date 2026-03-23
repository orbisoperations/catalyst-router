import { Hono } from 'hono'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import type { VideoConfig } from './config.js'
import { generateMediaMtxConfig, serializeMediaMtxConfig } from './mediamtx/config-generator.js'
import { ProcessManager } from './mediamtx/process-manager.js'
import { ControlApiClient } from './mediamtx/control-api-client.js'
import { createAuthHook } from './hooks/auth.js'
import { createLifecycleHooks } from './hooks/lifecycle.js'
import {
  StreamRouteManager,
  type StreamRouteManagerOptions,
} from './routes/stream-route-manager.js'
import { ReconnectingClient, type ReconnectingClientOptions } from './rpc/reconnecting-client.js'
import { TokenRefreshScheduler, type TokenRefreshOptions } from './rpc/token-refresh.js'
import { RelayManager, type RelayManagerOptions } from './routes/relay-manager.js'
import { SessionRegistry } from './session/session-registry.js'
import { TokenRevalidator, type TokenRevalidatorOptions } from './session/token-revalidator.js'
import { createVideoMetrics } from './metrics.js'
import { newWebSocketRpcSession } from 'capnweb'
import { decodeJwt } from 'jose'
import {
  AuthorizationEngine,
  CATALYST_SCHEMA,
  ALL_POLICIES,
  jwtToEntity,
  type CatalystPolicyDomain,
} from '@catalyst/authorization'
import type { DataChannelDefinition, InternalRoute, RouteChange } from '@catalyst/routing/v2'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface VideoStreamServiceOptions extends CatalystServiceOptions {
  videoConfig: VideoConfig
  deps?: VideoServiceDeps
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

export interface VideoServiceDeps {
  createControlApiClient?: (
    options: ConstructorParameters<typeof ControlApiClient>[0]
  ) => ControlApiClient
  createProcessManager?: (
    options: ConstructorParameters<typeof ProcessManager>[0]
  ) => ProcessManager
  createStreamRouteManager?: (options: StreamRouteManagerOptions) => StreamRouteManager
  createRelayManager?: (options: RelayManagerOptions) => RelayManager
  createReconnectingClient?: (options: ReconnectingClientOptions) => ReconnectingClient
  createTokenScheduler?: (options: TokenRefreshOptions) => TokenRefreshScheduler
  createSessionRegistry?: () => SessionRegistry
  createTokenRevalidator?: (options: TokenRevalidatorOptions) => TokenRevalidator
  rpcSessionFactory?: typeof newWebSocketRpcSession
  fetchImpl?: typeof fetch
}

const defaultVideoServiceDeps: Required<VideoServiceDeps> = {
  createControlApiClient: (options) => new ControlApiClient(options),
  createProcessManager: (options) => new ProcessManager(options),
  createStreamRouteManager: (options) => new StreamRouteManager(options),
  createRelayManager: (options) => new RelayManager(options),
  createReconnectingClient: (options) => new ReconnectingClient(options),
  createTokenScheduler: (options) => new TokenRefreshScheduler(options),
  createSessionRegistry: () => new SessionRegistry(),
  createTokenRevalidator: (options) => new TokenRevalidator(options),
  rpcSessionFactory: newWebSocketRpcSession,
  fetchImpl: fetch,
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
  private readonly deps: Required<VideoServiceDeps>
  private processManager?: ProcessManager
  private controlApiClient?: ControlApiClient
  private routeManager?: StreamRouteManager
  private configPath?: string
  private rpcClient?: ReconnectingClient
  private tokenScheduler?: TokenRefreshScheduler
  private relayManager?: RelayManager
  private currentToken?: string
  private dataChannel?: DataChannel
  private tokenRevalidator?: TokenRevalidator
  private livenessTimer?: ReturnType<typeof setInterval>
  private stoppingProcess = false

  constructor(options: VideoStreamServiceOptions) {
    super(options)
    this.videoConfig = options.videoConfig
    this.deps = { ...defaultVideoServiceDeps, ...options.deps }
  }

  protected async onInitialize(): Promise<void> {
    this.stoppingProcess = false
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
    this.controlApiClient = this.deps.createControlApiClient({
      baseUrl: `http://127.0.0.1:${this.videoConfig.apiPort}`,
    })

    // Create OTEL metrics instruments
    const metrics = createVideoMetrics()

    // Create session registry for subscriber tracking (revalidation sweep)
    const sessionRegistry = this.deps.createSessionRegistry!()

    // Wire auth hook with real Cedar STREAM_VIEW evaluation
    const domainId = this.config.node.domains?.[0] ?? 'default'
    const cedarEngine = new AuthorizationEngine<CatalystPolicyDomain>(CATALYST_SCHEMA, ALL_POLICIES)
    const authHook = createAuthHook({
      tokenValidator: {
        validate: async (token) => {
          try {
            const authBase = this.videoConfig.authEndpoint.replace(/^ws/, 'http')
            const res = await this.deps.fetchImpl(`${authBase}/verify`, {
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
      streamAccess: {
        evaluate: (payload, resource) => {
          const entity = jwtToEntity(payload)
          const builder = cedarEngine.entityBuilderFactory.createEntityBuilder()
          builder.entity('CATALYST::Route', resource.nodeId).setAttributes({
            nodeId: resource.nodeId,
            domainId: resource.domainId,
          })
          const entities = [entity, ...builder.build().getAll()]
          const result = cedarEngine.isAuthorized({
            principal: entity.uid,
            action: 'CATALYST::Action::STREAM_VIEW',
            resource: { type: 'CATALYST::Route', id: resource.nodeId },
            entities,
            context: {},
          })
          if (result.type === 'failure') return 'deny'
          return result.decision
        },
      },
      nodeId: this.config.node.name,
      domainId,
      metrics,
      sessionRegistry,
    })
    this.handler.route('/', authHook)

    // Detect transport-level failures in DataChannel RPC calls and trigger
    // reconnection. Only exceptions from the RPC layer (dead WebSocket, network
    // error) indicate transport failure. Discriminated union { success: false }
    // results are application errors and do NOT trigger reconnect.
    const handleTransportError = (err: unknown): void => {
      this.telemetry.logger.warn('DataChannel RPC failed, triggering reconnect: {error}', {
        'event.name': 'video.rpc.transport_error',
        error: err instanceof Error ? err.message : String(err),
      })
      this.rpcClient?.onDisconnect()
    }

    // Wire lifecycle hooks with route manager — registrar delegates to DataChannel
    this.routeManager = this.deps.createStreamRouteManager({
      registrar: {
        addRoute: async (route) => {
          if (!this.dataChannel) throw new Error('Not connected to orchestrator')
          let result: { success: true } | { success: false; error: string }
          try {
            result = await this.dataChannel.addRoute(route)
          } catch (err) {
            handleTransportError(err)
            throw err
          }
          if (!result.success) throw new Error(result.error)
        },
        removeRoute: async (name) => {
          if (!this.dataChannel) throw new Error('Not connected to orchestrator')
          let result: { success: true } | { success: false; error: string }
          try {
            result = await this.dataChannel.removeRoute({ name })
          } catch (err) {
            handleTransportError(err)
            throw err
          }
          if (!result.success) throw new Error(result.error)
        },
      },
      metadataProvider: {
        getPathMetadata: async (path) => {
          const result = await this.controlApiClient!.getPath(path)
          if (!result.ok || !result.data) return null
          return {
            tracks: result.data.tracks ?? [],
            sourceType: result.data.source?.type ?? 'unknown',
          }
        },
      },
      advertiseAddress: this.videoConfig.advertiseAddress ?? 'localhost',
      rtspPort: this.videoConfig.rtspPort,
      maxStreams: this.videoConfig.maxStreams,
      metrics,
    })
    const lifecycleHooks = createLifecycleHooks({
      routeManager: this.routeManager,
      sessionRegistry,
      onLastSubscriberLeft: (path) => {
        this.tokenRevalidator?.addPendingEviction(path)
      },
    })
    this.handler.route('/', lifecycleHooks)

    // Wire RelayManager — RouteSubscription delegates to DataChannel
    this.relayManager = this.deps.createRelayManager({
      routeSource: {
        watchRoutes: (cb) => {
          if (!this.dataChannel) throw new Error('Not connected to orchestrator')
          try {
            return this.dataChannel.watchRoutes(cb)
          } catch (err) {
            handleTransportError(err)
            throw err
          }
        },
        listRoutes: async () => {
          if (!this.dataChannel) throw new Error('Not connected to orchestrator')
          try {
            return await this.dataChannel.listRoutes()
          } catch (err) {
            handleTransportError(err)
            throw err
          }
        },
      },
      controlApi: this.controlApiClient!,
      localNodeName: this.config.node.name,
      getRelayToken: () => this.currentToken!,
      metrics,
    })

    // Wire TokenRevalidator — periodic sweep + relay cleanup callback
    this.tokenRevalidator = this.deps.createTokenRevalidator!({
      registry: sessionRegistry,
      controlApi: this.controlApiClient!,
      onPathSubscribersEvicted: (path) => this.relayManager!.onSubscribersEvicted(path),
      metrics,
    })

    // Token minting — connect to auth service for DATA_CUSTODIAN token
    const mintToken = async (): Promise<string> => {
      const authClient = this.deps.rpcSessionFactory<AuthRpcApi>(this.videoConfig.authEndpoint)
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
      const stub = this.deps.rpcSessionFactory<OrchestratorPublicApi>(
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
    this.rpcClient = this.deps.createReconnectingClient({
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
    this.tokenScheduler = this.deps.createTokenScheduler({
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
        // Trigger a full reconnect cycle: doConnect() is the single mint owner
        // (mintToken → connect → reconcile). This replaces the stale DataChannel
        // RPC session with one authenticated by the fresh token.
        this.rpcClient?.reconnect().catch((err) => {
          this.telemetry.logger.error('DataChannel reconnect after token refresh failed: {error}', {
            'event.name': 'video.rpc.token_refresh_reconnect_failed',
            error: err instanceof Error ? err.message : String(err),
          })
        })
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
    this.processManager = this.deps.createProcessManager({
      binaryPath: process.env.MEDIAMTX_PATH ?? 'mediamtx',
      configPath: this.configPath,
    })

    let hasStartedOnce = false
    this.processManager.on('started', (pid) => {
      metrics.mediamtxRunning.add(1)
      this.telemetry.logger.info('MediaMTX process started (pid: {pid})', {
        'event.name': 'video.mediamtx.started',
        pid,
      })
      // After a crash-restart, withdraw stale routes. The runOnReady hooks
      // will re-register any paths that become active on the new process.
      if (hasStartedOnce && this.routeManager && this.routeManager.streamCount > 0) {
        this.telemetry.logger.info('MediaMTX restarted — reconciling stale routes', {
          'event.name': 'video.route.reconcile_after_restart',
          staleCount: this.routeManager.streamCount,
        })
        this.routeManager.withdrawAll().catch((err) => {
          this.telemetry.logger.error('Failed to reconcile routes after restart: {error}', {
            'event.name': 'video.route.reconcile_failed',
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
      hasStartedOnce = true
    })

    this.processManager.on('exited', (exitCode, signal) => {
      metrics.mediamtxRunning.add(-1)
      if (!this.stoppingProcess) {
        metrics.mediamtxCrashes.add(1)
      }
      this.telemetry.logger.warn('MediaMTX process exited (code: {exitCode})', {
        'event.name': 'video.mediamtx.exited',
        exitCode,
        signal,
      })
    })

    this.processManager.on('restarting', (attempt, maxAttempts) => {
      metrics.mediamtxRestarts.add(1)
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
      // Withdraw all stale routes — MediaMTX is down, streams are gone
      this.routeManager?.withdrawAll().catch((err) => {
        this.telemetry.logger.error('Failed to withdraw routes on degraded: {error}', {
          'event.name': 'video.route.withdraw_degraded_failed',
          error: err instanceof Error ? err.message : String(err),
        })
      })
    })

    await this.processManager.start()

    // Start session revalidation sweep after MediaMTX is running
    this.tokenRevalidator?.start()

    // Periodic liveness probe: detect dead DataChannel during idle periods.
    // watchRoutes() silently stops delivering events when the WebSocket dies —
    // there's no error callback. This probe catches that by calling listRoutes()
    // through the transport-error-detecting wrapper every 60 seconds.
    this.livenessTimer = setInterval(async () => {
      if (!this.dataChannel || !this.rpcClient?.connected) return
      try {
        await Promise.race([
          this.dataChannel.listRoutes(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Liveness probe timeout')), 10_000)
          ),
        ])
      } catch (err) {
        handleTransportError(err)
      }
    }, 60_000)

    this.telemetry.logger.info('VideoStreamService started on {nodeId}', {
      'event.name': 'video.service.started',
      nodeId: this.config.node.name,
    })
  }

  protected async onShutdown(): Promise<void> {
    // Step 1: Stop accepting new hooks (token scheduler + relay manager + revalidator + probe)
    this.tokenScheduler?.stop()
    this.tokenRevalidator?.stop()
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = undefined
    }
    this.relayManager?.shutdown()

    // Step 2: Best-effort withdraw all stream routes (3-second timeout)
    if (this.routeManager && this.routeManager.streamCount > 0) {
      try {
        await Promise.race([
          this.routeManager.withdrawAll(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Route withdrawal timed out')), 3000)
          ),
        ])
      } catch (err) {
        this.telemetry.logger.warn('Route withdrawal on shutdown incomplete: {error}', {
          'event.name': 'video.route.shutdown_withdraw_timeout',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } else {
      this.routeManager?.shutdown()
    }

    // Step 3: Close RPC connections
    this.rpcClient?.stop()

    // Step 4: Stop MediaMTX process (SIGTERM then SIGKILL)
    this.stoppingProcess = true
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
