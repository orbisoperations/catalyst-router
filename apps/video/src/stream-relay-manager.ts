import type { Counter, Histogram, Meter, UpDownCounter } from '@opentelemetry/api'
import { DURATION_BUCKETS, getLogger } from '@catalyst/telemetry'

const logger = getLogger('stream-relay-manager')

export interface StreamRelaySession {
  routeKey: string
  activeViewers: number
  startedAt: number
  gracePeriodTimer: ReturnType<typeof setTimeout> | null
}

interface RelayManagerConfig {
  relayGracePeriodMs: number
}

interface RelayManagerCallbacks {
  onRelayStart: (routeKey: string) => Promise<void>
  onRelayTeardown: (routeKey: string) => Promise<void>
  deletePath?: (name: string) => Promise<void>
}

export class StreamRelayManager {
  private sessions = new Map<string, StreamRelaySession>()
  private config: RelayManagerConfig
  private callbacks: RelayManagerCallbacks

  private activeSessions?: UpDownCounter
  private activeViewers?: UpDownCounter
  private starts?: Counter
  private teardowns?: Counter
  private sessionDuration?: Histogram

  constructor(config: RelayManagerConfig, callbacks: RelayManagerCallbacks, meter?: Meter) {
    this.config = config
    this.callbacks = callbacks

    if (meter) {
      this.activeSessions = meter.createUpDownCounter('video.relay.active_sessions', {
        unit: '{session}',
        description: 'Number of active relay sessions',
      })
      this.activeViewers = meter.createUpDownCounter('video.relay.active_viewers', {
        unit: '{viewer}',
        description: 'Number of active viewers across all relay sessions',
      })
      this.starts = meter.createCounter('video.relay.starts', {
        unit: '{start}',
        description: 'Total number of relay session starts',
      })
      this.teardowns = meter.createCounter('video.relay.teardowns', {
        unit: '{teardown}',
        description: 'Total number of relay session teardowns',
      })
      this.sessionDuration = meter.createHistogram('video.relay.session.duration', {
        unit: 's',
        description: 'Duration of relay sessions',
        advice: { explicitBucketBoundaries: DURATION_BUCKETS },
      })
    }
  }

  async addViewer(routeKey: string): Promise<void> {
    const existing = this.sessions.get(routeKey)

    if (existing) {
      if (existing.gracePeriodTimer !== null) {
        clearTimeout(existing.gracePeriodTimer)
        existing.gracePeriodTimer = null
      }
      existing.activeViewers++
      this.activeViewers?.add(1)
      return
    }

    const session: StreamRelaySession = {
      routeKey,
      activeViewers: 1,
      startedAt: Date.now(),
      gracePeriodTimer: null,
    }
    this.sessions.set(routeKey, session)

    this.activeSessions?.add(1)
    this.activeViewers?.add(1)
    this.starts?.add(1, { 'video.relay.route_key': routeKey })

    logger.info`Starting relay for ${routeKey} (activeSessions=${this.sessions.size})`
    await this.callbacks.onRelayStart(routeKey)
  }

  removeViewer(routeKey: string): void {
    const session = this.sessions.get(routeKey)
    if (!session) return

    session.activeViewers = Math.max(0, session.activeViewers - 1)
    this.activeViewers?.add(-1)

    if (session.activeViewers === 0) {
      logger.info`Last viewer disconnected from ${routeKey}, starting grace period (${this.config.relayGracePeriodMs}ms)`
      session.gracePeriodTimer = setTimeout(() => {
        logger.info`Grace period expired for ${routeKey}, tearing down relay (activeSessions=${this.sessions.size - 1})`
        this.activeSessions?.add(-1)
        this.teardowns?.add(1)
        this.sessionDuration?.record((Date.now() - session.startedAt) / 1000)
        this.sessions.delete(routeKey)
        this.callbacks.onRelayTeardown(routeKey).catch((err) => {
          logger.error`Failed to teardown relay for ${routeKey}: ${err}`
        })
      }, this.config.relayGracePeriodMs)
    }
  }

  async onRouteWithdrawn(routeKey: string): Promise<void> {
    const session = this.sessions.get(routeKey)
    if (!session) return

    logger.info`Route withdrawn for ${routeKey}, immediate teardown (activeSessions=${this.sessions.size - 1})`
    if (session.gracePeriodTimer !== null) {
      clearTimeout(session.gracePeriodTimer)
    }
    this.activeSessions?.add(-1)
    this.activeViewers?.add(-session.activeViewers)
    this.teardowns?.add(1)
    this.sessionDuration?.record((Date.now() - session.startedAt) / 1000)
    await this.callbacks.onRelayTeardown(routeKey)
    this.sessions.delete(routeKey)
  }

  getSession(routeKey: string): StreamRelaySession | undefined {
    return this.sessions.get(routeKey)
  }

  /**
   * T026: Adopt an already-running relay session.
   * Used during reconciliation when the video service discovers existing
   * MediaMTX paths that should be tracked without triggering onRelayStart.
   */
  adopt(name: string, viewerCount: number): void {
    const existing = this.sessions.get(name)
    if (existing) {
      if (existing.gracePeriodTimer !== null) {
        clearTimeout(existing.gracePeriodTimer)
        existing.gracePeriodTimer = null
      }
      const delta = viewerCount - existing.activeViewers
      existing.activeViewers = viewerCount
      this.activeViewers?.add(delta)
      return
    }

    const session: StreamRelaySession = {
      routeKey: name,
      activeViewers: viewerCount,
      startedAt: Date.now(),
      gracePeriodTimer: null,
    }
    this.sessions.set(name, session)

    this.activeSessions?.add(1)
    this.activeViewers?.add(viewerCount)
    this.starts?.add(1, { 'video.relay.route_key': name })

    logger.info`Adopted relay for ${name} with ${viewerCount} viewers (activeSessions=${this.sessions.size})`
  }

  /**
   * T027: Teardown all active relay sessions.
   * Uses the injected deletePath callback to remove paths from MediaMTX.
   */
  async teardownAll(): Promise<void> {
    const entries = [...this.sessions.entries()]
    for (const [name, session] of entries) {
      if (session.gracePeriodTimer !== null) {
        clearTimeout(session.gracePeriodTimer)
      }
      let teardownAttrs: Record<string, string> | undefined
      if (this.callbacks.deletePath) {
        try {
          await this.callbacks.deletePath(name)
        } catch (err) {
          logger.error`Failed to DELETE path ${name} from MediaMTX: ${err}`
          teardownAttrs = { 'error.type': err instanceof Error ? err.name : String(err) }
        }
      }
      this.activeSessions?.add(-1)
      this.activeViewers?.add(-session.activeViewers)
      this.teardowns?.add(1, teardownAttrs)
      this.sessionDuration?.record((Date.now() - session.startedAt) / 1000)
      await this.callbacks.onRelayTeardown(name).catch((err) => {
        logger.error`Failed to teardown relay for ${name}: ${err}`
      })
    }
    this.sessions.clear()
    logger.info`Tore down all relay sessions (count=${entries.length})`
  }

  /**
   * T028: Start grace period for an existing session.
   * Used by reconciliation for paths with 0 readers but matching route.
   */
  startGracePeriod(name: string): void {
    const session = this.sessions.get(name)
    if (!session) return

    if (session.gracePeriodTimer !== null) {
      clearTimeout(session.gracePeriodTimer)
    }

    if (session.activeViewers > 0) {
      this.activeViewers?.add(-session.activeViewers)
    }
    session.activeViewers = 0
    logger.info`Starting grace period for ${name} (reconciliation, ${this.config.relayGracePeriodMs}ms)`
    session.gracePeriodTimer = setTimeout(() => {
      logger.info`Grace period expired for ${name}, tearing down relay (activeSessions=${this.sessions.size - 1})`
      this.activeSessions?.add(-1)
      this.teardowns?.add(1)
      this.sessionDuration?.record((Date.now() - session.startedAt) / 1000)
      this.sessions.delete(name)
      this.callbacks.onRelayTeardown(name).catch((err) => {
        logger.error`Failed to teardown relay for ${name}: ${err}`
      })
    }, this.config.relayGracePeriodMs)
  }
}
