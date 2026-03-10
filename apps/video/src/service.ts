import { Hono } from 'hono'
import { newWebSocketRpcSession } from 'capnweb'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import { getLogger } from '@catalyst/telemetry'

import { VideoBusClient } from './bus-client.js'
import { VideoRpcServer } from './rpc-server.js'
import { createVideoRpcHandler } from './rpc-handler.js'
import { createReconciler, type ReconcileController } from './reconcile.js'
import { StreamRelayManager } from './stream-relay-manager.js'
import { createVideoHooks, queryStreamCatalog } from './video-control.js'
import { Action as AuthAction } from '@catalyst/authorization'
import { createVideoSubscribe } from './video-subscribe.js'
import { createVideoAuthService, type VideoAuthService } from './video-auth.js'

const logger = getLogger(['video', 'service'])

/**
 * Auth service RPC API shape (mirrors orchestrator's AuthServiceApi).
 */
interface AuthServiceApi {
  permissions(token: string): Promise<
    | {
        authorizeAction(request: {
          action: string
          nodeContext: { nodeId: string; domains: string[] }
        }): Promise<
          | { success: true; allowed: boolean }
          | { success: false; errorType: string; reason?: string; reasons?: string[] }
        >
      }
    | { error: string }
  >
}

/**
 * Create an auth RPC session. capnweb connects lazily — actual connection
 * failures surface on first RPC call (permissions), not at session creation.
 * Retry logic lives in the auth service's evaluate() path where failures
 * are naturally handled (fail-closed).
 */
function createAuthSession(
  endpoint: string
): ReturnType<typeof newWebSocketRpcSession<AuthServiceApi>> {
  return newWebSocketRpcSession<AuthServiceApi>(endpoint)
}

export class VideoStreamService extends CatalystService {
  readonly info = { name: 'video', version: '0.0.0' }
  readonly handler = new Hono()

  private catalogReady = false
  private shuttingDown = false

  // Components initialized in onInitialize()
  private busClient!: VideoBusClient
  private relayManager!: StreamRelayManager
  private rpcServer!: VideoRpcServer
  private reconciler!: ReconcileController
  private videoAuth!: VideoAuthService
  private authClient?: ReturnType<typeof newWebSocketRpcSession<AuthServiceApi>>
  private videoControlCleanup?: () => void

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  protected async onInitialize(): Promise<void> {
    const videoConfig = this.config.video
    if (!videoConfig) {
      throw new Error('Video config (config.video) is required for VideoStreamService')
    }

    const nodeId = this.config.node.name
    const domains = this.config.node.domains ?? []

    // 1. Auth setup (optional)
    await this.setupAuth(videoConfig)

    // 2. Create VideoBusClient
    this.busClient = new VideoBusClient()

    // 3. Create StreamRelayManager
    const mediamtxApiUrl = videoConfig.mediamtxApiUrl
    this.relayManager = new StreamRelayManager(
      { relayGracePeriodMs: videoConfig.relayGracePeriodMs },
      {
        onRelayStart: async (routeKey) => {
          logger.info`Relay started for ${routeKey}`
        },
        onRelayTeardown: async (routeKey) => {
          logger.info`Relay torn down for ${routeKey}`
        },
        deletePath: async (name) => {
          const encoded = name
            .split('/')
            .map((s) => encodeURIComponent(s))
            .join('/')
          const url = `${mediamtxApiUrl}/v3/paths/${encoded}`
          const res = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(5000) })
          if (!res.ok && res.status !== 404) {
            throw new Error(`DELETE ${name} returned ${res.status}`)
          }
        },
      }
    )

    // 4. Create reconciler
    this.reconciler = createReconciler({
      mediamtxApiUrl,
      relayManager: this.relayManager,
      getCatalog: () => this.busClient.catalog,
    })

    // 5. Create VideoRpcServer
    this.rpcServer = new VideoRpcServer({
      busClient: this.busClient,
      onCatalogUpdate: async () => {
        // Fire-and-forget: reconciliation runs in background, doesn't block catalog ack
        this.reconciler.reconcile().catch((err) => {
          logger.error`Reconciliation failed: ${err}`
        })
      },
      onCatalogReady: () => {
        if (this.shuttingDown) return
        this.catalogReady = true
        logger.info`Catalog ready — service accepting requests`
      },
      onCatalogLost: () => {
        this.catalogReady = false
        logger.info`Catalog lost — service rejecting requests until reconnect`
      },
      onTokenRefresh: async (token: string) => {
        logger.info`Token refresh received via RPC — reconnecting auth`
        await this.refreshAuthWithToken(token, videoConfig.authEndpoint)
      },
    })

    // 6. Mount RPC handler at /api
    this.handler.route('/api', createVideoRpcHandler(this.rpcServer))

    // Auth delegate: always reads the current this.videoAuth so token refresh propagates
    const authDelegate = {
      evaluate: (req: Parameters<VideoAuthService['evaluate']>[0]) => this.videoAuth.evaluate(req),
    }

    // 7. Create and mount videoControl at /video-stream
    const videoControl = createVideoHooks({
      dispatch: (action) => this.busClient.dispatch(action),
      getCatalog: () => this.busClient.catalog,
      nodeId,
      debounceMs: videoConfig.debounceDurationMs,
      isReady: () => this.catalogReady,
      tracer: this.telemetry.tracer,
    })
    this.handler.route('/video-stream', videoControl.handler)
    this.videoControlCleanup = videoControl.cleanup

    // 8. Mount health + streams endpoints BEFORE catch-all subscribe handler
    this.handler.get('/healthz', (c) => c.json({ status: 'ok' }))
    this.handler.get('/readyz', (c) => {
      if (this.catalogReady) {
        return c.json({ ready: true, catalog: true })
      }
      return c.json({ ready: false, catalog: false }, 503)
    })
    this.handler.get('/streams', async (c) => {
      if (!this.catalogReady) {
        return c.json({ error: 'Service not ready' }, 503)
      }

      const authHeader = c.req.header('Authorization')
      if (!authHeader) {
        return c.json({ error: 'Authorization header required' }, 401)
      }
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
      try {
        const result = await authDelegate.evaluate({
          token,
          action: AuthAction.STREAM_DISCOVER,
          nodeContext: { nodeId, domains },
        })
        if (!result.success || !result.allowed) {
          return c.json({ error: 'Forbidden' }, 403)
        }
      } catch {
        return c.json({ error: 'Forbidden' }, 403)
      }

      const scope = c.req.query('scope')
      const sourceNode = c.req.query('sourceNode')
      const protocol = c.req.query('protocol')

      const catalog = this.busClient.catalog
      const streams = queryStreamCatalog(catalog.streams, {
        scope: scope || undefined,
        sourceNode: sourceNode || undefined,
        protocol: protocol || undefined,
      })
      return c.json({ streams })
    })

    // 9. Create and mount videoSubscribe (has catch-all pattern, must be last)
    const videoSubscribe = createVideoSubscribe({
      getCatalog: () => this.busClient.catalog,
      auth: authDelegate,
      config: {
        relayGracePeriodMs: videoConfig.relayGracePeriodMs,
        streamAuth: {
          legacyFallback: videoConfig.streamAuth.legacyFallback,
        },
        mediamtxApiUrl,
      },
      nodeId,
      domains,
      relayManager: this.relayManager,
      tracer: this.telemetry.tracer,
    })
    this.handler.route('/', videoSubscribe)

    logger.info`VideoStreamService initialized (nodeId=${nodeId})`
    // Return immediately — no blocking on orchestrator connection (two-phase lifecycle)
  }

  protected async onShutdown(): Promise<void> {
    // 1. Mark not ready and prevent re-activation
    this.shuttingDown = true
    this.catalogReady = false

    // 2. Cancel pending debounce timers
    this.videoControlCleanup?.()

    // 3. Drain pause for in-flight requests
    await new Promise((r) => setTimeout(r, 2000))

    // 4. Teardown all relays (FR-014)
    if (this.relayManager) {
      await this.relayManager.teardownAll()
    }

    // 5. Clear auth client reference
    this.authClient = undefined

    logger.info`VideoStreamService shut down`
  }

  /**
   * Set up auth client. Auth is OPTIONAL:
   * - If authEndpoint is not set, skip entirely
   * - If nodeToken is not set, start without auth (wait for RPC token push)
   * - If both are set, connect with retry
   */
  private async setupAuth(videoConfig: {
    authEndpoint?: string
    nodeToken?: string
  }): Promise<void> {
    if (!videoConfig.authEndpoint) {
      logger.info`No auth endpoint configured — auth will be set up when token is pushed via RPC`
      this.videoAuth = createVideoAuthService({})
      return
    }

    if (!videoConfig.nodeToken) {
      logger.info`Auth endpoint configured but no token available — waiting for token push via RPC`
      this.videoAuth = createVideoAuthService({})
      return
    }

    // Both endpoint and token available — create session (connects lazily)
    this.authClient = createAuthSession(videoConfig.authEndpoint)
    this.videoAuth = createVideoAuthService({ authClient: this.authClient })
    logger.info`Auth session created for ${videoConfig.authEndpoint}`
  }

  /**
   * Called when a new token is pushed via RPC's refreshToken().
   * Creates a new auth client with the token and updates the auth service.
   */
  private async refreshAuthWithToken(token: string, authEndpoint?: string): Promise<void> {
    if (!authEndpoint) {
      // Store the token but can't connect without an endpoint.
      // The token may be used by future auth setup if endpoint is provided later.
      logger.warn`Token received but no auth endpoint configured`
      return
    }

    this.authClient = createAuthSession(authEndpoint)
    this.videoAuth = createVideoAuthService({ authClient: this.authClient })
    logger.info`Auth session recreated with new token`
  }
}
