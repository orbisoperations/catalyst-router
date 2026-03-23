/**
 * Stream route manager with per-path debounced create/delete.
 *
 * Each stream path has its own pending timer. When ready fires, the
 * manager waits `debounceMs` before executing the route creation.
 * If a not-ready arrives during that window, the create is cancelled.
 * Same applies in reverse — a not-ready schedules deletion, and a
 * subsequent ready cancels it.
 *
 * This prevents route churn during camera reconnections (ready/not-ready
 * within milliseconds) from propagating unnecessary updates across the mesh.
 */

import { getLogger } from '@catalyst/telemetry'

const logger = getLogger(['catalyst', 'video', 'publish'])

export interface RouteRegistrar {
  addRoute(route: {
    name: string
    protocol: 'media'
    endpoint: string
    tags: string[]
  }): Promise<void>
  removeRoute(name: string): Promise<void>
}

export interface PathMetadataProvider {
  getPathMetadata(path: string): Promise<{ tracks: string[]; sourceType: string } | null>
}

export interface StreamMetrics {
  streamActive: { add(value: number): void }
  streamPublishes: { add(value: number): void }
  streamDisconnects: { add(value: number): void }
  routeOperations: { add(value: number, attributes?: Record<string, string>): void }
}

export interface StreamRouteManagerOptions {
  registrar: RouteRegistrar
  metadataProvider: PathMetadataProvider
  advertiseAddress: string
  rtspPort: number
  maxStreams: number
  debounceMs?: number
  metrics?: StreamMetrics
}

interface PendingAction {
  type: 'ready' | 'not-ready'
  timer: ReturnType<typeof setTimeout>
}

export class StreamRouteManager {
  private readonly registrar: RouteRegistrar
  private readonly metadataProvider: PathMetadataProvider
  private readonly advertiseAddress: string
  private readonly rtspPort: number
  private readonly maxStreams: number
  private readonly debounceMs: number
  private readonly metrics?: StreamMetrics

  /** Active routes (post-debounce, registered with orchestrator). */
  private readonly activeRoutes = new Set<string>()
  /** Pending debounce timers, keyed by path. */
  private readonly pending = new Map<string, PendingAction>()

  constructor(options: StreamRouteManagerOptions) {
    this.registrar = options.registrar
    this.metadataProvider = options.metadataProvider
    this.advertiseAddress = options.advertiseAddress
    this.rtspPort = options.rtspPort
    this.maxStreams = options.maxStreams
    this.debounceMs = options.debounceMs ?? 1000
    this.metrics = options.metrics
  }

  async handleReady(path: string, meta: { sourceType: string; sourceId: string }): Promise<void> {
    // Cancel any pending not-ready for this path
    const existing = this.pending.get(path)
    if (existing) {
      clearTimeout(existing.timer)
      this.pending.delete(path)
    }

    // Already active — no-op (idempotent)
    if (this.activeRoutes.has(path)) return

    // Max streams enforcement
    if (this.activeRoutes.size >= this.maxStreams) {
      throw new Error(`Max streams limit reached (${this.maxStreams}). Rejecting stream: ${path}`)
    }

    logger.debug('Debouncing stream event for {streamPath}', {
      'event.name': 'video.stream.debounced',
      streamPath: path,
      debounceMs: this.debounceMs,
    })

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(async () => {
        this.pending.delete(path)
        try {
          const metadata = await this.metadataProvider.getPathMetadata(path)
          const tags = metadata
            ? [...metadata.tracks.map((t) => `track:${t}`), `source-type:${meta.sourceType}`]
            : [`source-type:${meta.sourceType}`]

          const endpoint = `rtsp://${this.advertiseAddress}:${this.rtspPort}/${path}`
          await this.registrar.addRoute({
            name: path,
            protocol: 'media',
            endpoint,
            tags,
          })
          this.activeRoutes.add(path)
          this.metrics?.streamActive.add(1)
          this.metrics?.streamPublishes.add(1)
          this.metrics?.routeOperations.add(1, { operation: 'add' })
          logger.info('Route registered for {streamPath}', {
            'event.name': 'video.route.added',
            streamPath: path,
            endpoint,
          })
          resolve()
        } catch (err) {
          logger.error('Failed to register route for {streamPath}: {error}', {
            'event.name': 'video.route.add_failed',
            streamPath: path,
            error: err instanceof Error ? err.message : String(err),
          })
          reject(err)
        }
      }, this.debounceMs)

      this.pending.set(path, { type: 'ready', timer })
    })
  }

  async handleNotReady(path: string): Promise<void> {
    // Cancel any pending ready for this path
    const existing = this.pending.get(path)
    if (existing) {
      clearTimeout(existing.timer)
      this.pending.delete(path)
    }

    // Not active — no-op
    if (!this.activeRoutes.has(path)) return

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(async () => {
        this.pending.delete(path)
        try {
          await this.registrar.removeRoute(path)
          this.activeRoutes.delete(path)
          this.metrics?.streamActive.add(-1)
          this.metrics?.streamDisconnects.add(1)
          this.metrics?.routeOperations.add(1, { operation: 'remove' })
          logger.info('Route removed for {streamPath}', {
            'event.name': 'video.route.removed',
            streamPath: path,
          })
          resolve()
        } catch (err) {
          reject(err)
        }
      }, this.debounceMs)

      this.pending.set(path, { type: 'not-ready', timer })
    })
  }

  /** Get the number of active streams. */
  get streamCount(): number {
    return this.activeRoutes.size
  }

  /**
   * Withdraw all active routes from the orchestrator and reset state.
   * Used on MediaMTX degraded/restart and orderly shutdown.
   * Best-effort: individual withdrawal failures are logged but don't block.
   */
  async withdrawAll(): Promise<void> {
    // Cancel all pending timers first
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
    }
    this.pending.clear()

    const paths = [...this.activeRoutes]
    if (paths.length === 0) return

    logger.info('Withdrawing {count} active route(s)', {
      'event.name': 'video.route.withdraw_all',
      count: paths.length,
    })

    const results = await Promise.allSettled(
      paths.map(async (path) => {
        await this.registrar.removeRoute(path)
        this.activeRoutes.delete(path)
      })
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn('Failed to withdraw route: {error}', {
          'event.name': 'video.route.withdraw_failed',
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    }
  }

  /** Shutdown: cancel all pending timers. */
  shutdown(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
    }
    this.pending.clear()
  }
}
