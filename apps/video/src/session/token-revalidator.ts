import { getLogger } from '@catalyst/telemetry'
import type { SessionRegistry } from './session-registry.js'
import type { ControlApiClient } from '../mediamtx/control-api-client.js'

const logger = getLogger(['catalyst', 'video', 'revalidator'])

export interface RevalidatorMetrics {
  sessionKicks: { add(value: number, attributes?: Record<string, string>): void }
  revalidationSweeps: { add(value: number): void }
}

export interface TokenRevalidatorOptions {
  registry: SessionRegistry
  controlApi: ControlApiClient
  onPathSubscribersEvicted?: (path: string) => Promise<boolean>
  sweepIntervalMs?: number
  reconcileIntervalMs?: number
  metrics?: RevalidatorMetrics
}

/**
 * Periodic sweep engine that checks subscriber session JWT expiry and kicks
 * expired sessions via MediaMTX per-protocol APIs.
 *
 * O(1) per session: only compares `exp` against `Date.now()`. No auth service
 * RPC, no Cedar re-evaluation. Expired sessions are kicked via ControlApiClient.
 * Registry entries are only removed on successful kick (ok) or 404 (already gone).
 * Transient failures leave the entry for retry on the next sweep.
 *
 * A reconciliation pass runs every 5 minutes to garbage-collect leaked entries
 * where the session disconnected without the runOnUnread hook firing.
 */
export class TokenRevalidator {
  private readonly registry: SessionRegistry
  private readonly controlApi: ControlApiClient
  private readonly onPathSubscribersEvicted?: (path: string) => Promise<boolean>
  private readonly sweepIntervalMs: number
  private readonly reconcileIntervalMs: number
  private readonly metrics?: RevalidatorMetrics

  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  /** Paths where relay eviction failed — retried on the next sweep. */
  private readonly pendingEvictions = new Set<string>()

  constructor(options: TokenRevalidatorOptions) {
    this.registry = options.registry
    this.controlApi = options.controlApi
    this.onPathSubscribersEvicted = options.onPathSubscribersEvicted
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 300_000
    this.metrics = options.metrics
  }

  start(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs)
    this.reconcileTimer = setInterval(() => void this.reconcile(), this.reconcileIntervalMs)
  }

  /** Queue a path for relay eviction on the next sweep. */
  addPendingEviction(path: string): void {
    this.pendingEvictions.add(path)
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
  }

  async sweep(): Promise<number> {
    this.metrics?.revalidationSweeps.add(1)
    const now = Date.now()
    let kickCount = 0
    const evictedPaths = new Set<string>()

    for (const entry of [...this.registry.entries()]) {
      if (entry.exp >= now) continue

      // HLS is stateless — the auth hook re-validates per segment request.
      // Just remove the expired entry for bookkeeping; don't count as a kick.
      if (entry.protocol === 'hls') {
        this.registry.remove(entry.id)
        evictedPaths.add(entry.path)
        logger.debug('HLS session expired, removed from registry: {id} on {path}', {
          'event.name': 'video.session.hls_expired',
          id: entry.id,
          path: entry.path,
        })
        continue
      }

      const result = await this.controlApi.kickSession(entry.id, entry.protocol)

      if (result.ok) {
        this.registry.remove(entry.id)
        kickCount++
        evictedPaths.add(entry.path)
        this.metrics?.sessionKicks.add(1, { reason: 'expired', protocol: entry.protocol })
        logger.info('Kicked expired session {id} on {path} ({protocol})', {
          'event.name': 'video.session.kicked',
          id: entry.id,
          path: entry.path,
          protocol: entry.protocol,
          reason: 'expired',
        })
      } else if (result.status === 404) {
        // Session already gone — clean up the registry entry but don't
        // count as an active kick (avoids inflating operational metrics).
        this.registry.remove(entry.id)
        evictedPaths.add(entry.path)
        logger.debug('Stale session entry cleaned: {id} on {path} (already disconnected)', {
          'event.name': 'video.session.stale_cleaned',
          id: entry.id,
          path: entry.path,
          protocol: entry.protocol,
        })
      } else {
        logger.warn('Kick failed for {id}, will retry: {error}', {
          'event.name': 'video.session.kick_failed',
          id: entry.id,
          path: entry.path,
          error: result.error,
        })
      }
    }

    // Notify relay cleanup for paths with zero remaining subscribers.
    // Also retry any paths where eviction previously failed.
    if (this.onPathSubscribersEvicted) {
      for (const path of evictedPaths) {
        if (this.registry.getByPath(path).length === 0) {
          this.pendingEvictions.add(path)
        }
      }
      for (const path of [...this.pendingEvictions]) {
        // Re-check: a new subscriber may have connected since last sweep
        if (this.registry.getByPath(path).length > 0) {
          this.pendingEvictions.delete(path)
          continue
        }
        try {
          const cleaned = await this.onPathSubscribersEvicted(path)
          if (cleaned) this.pendingEvictions.delete(path)
          // If not cleaned, stays in pendingEvictions for retry next sweep
        } catch {
          // Callback threw — keep in pendingEvictions for retry
        }
      }
    }

    return kickCount
  }

  async reconcile(): Promise<void> {
    const [rtspResult, rtmpResult, hlsResult] = await Promise.all([
      this.controlApi.listRtspSessions(),
      this.controlApi.listRtmpConns(),
      this.controlApi.listHlsMuxers(),
    ])

    // Build active sets only for protocols whose list call succeeded.
    // If a list call fails, we skip that protocol entirely — an empty
    // active set would incorrectly purge every entry for that protocol.
    const rtspIds = new Set<string>()
    const rtmpIds = new Set<string>()
    const hlsPaths = new Set<string>()

    if (rtspResult.ok) {
      for (const item of rtspResult.data.items) {
        if (item.id) rtspIds.add(item.id)
      }
    } else {
      logger.warn('Reconcile: skipping RTSP — list failed: {error}', {
        'event.name': 'video.session.reconcile_skip',
        protocol: 'rtsp',
        error: rtspResult.error,
      })
    }

    if (rtmpResult.ok) {
      for (const item of rtmpResult.data.items) {
        if (item.id) rtmpIds.add(item.id)
      }
    } else {
      logger.warn('Reconcile: skipping RTMP — list failed: {error}', {
        'event.name': 'video.session.reconcile_skip',
        protocol: 'rtmp',
        error: rtmpResult.error,
      })
    }

    if (hlsResult.ok) {
      for (const item of hlsResult.data.items) {
        hlsPaths.add(item.path)
      }
    } else {
      logger.warn('Reconcile: skipping HLS — list failed: {error}', {
        'event.name': 'video.session.reconcile_skip',
        protocol: 'hls',
        error: hlsResult.error,
      })
    }

    const reconciledPaths = new Set<string>()
    for (const entry of [...this.registry.entries()]) {
      let isLeaked = false

      if (entry.protocol === 'rtsp' && rtspResult.ok) {
        isLeaked = !rtspIds.has(entry.id)
      } else if (entry.protocol === 'rtmp' && rtmpResult.ok) {
        isLeaked = !rtmpIds.has(entry.id)
      } else if (entry.protocol === 'hls' && hlsResult.ok) {
        isLeaked = !hlsPaths.has(entry.path)
      }
      // If the list call failed for this protocol, isLeaked stays false — skip it.

      if (isLeaked) {
        this.registry.remove(entry.id)
        reconciledPaths.add(entry.path)
        logger.debug('Reconcile: removed leaked session {id} ({protocol})', {
          'event.name': 'video.session.reconcile_removed',
          id: entry.id,
          protocol: entry.protocol,
        })
      }
    }

    // Run relay cleanup immediately for paths that now have zero subscribers
    if (this.onPathSubscribersEvicted) {
      for (const path of reconciledPaths) {
        if (this.registry.getByPath(path).length === 0) {
          this.pendingEvictions.add(path)
        }
      }
      for (const path of [...this.pendingEvictions]) {
        if (this.registry.getByPath(path).length > 0) {
          this.pendingEvictions.delete(path)
          continue
        }
        try {
          const cleaned = await this.onPathSubscribersEvicted(path)
          if (cleaned) this.pendingEvictions.delete(path)
        } catch {
          // Keep in pendingEvictions for retry
        }
      }
    }
  }
}
