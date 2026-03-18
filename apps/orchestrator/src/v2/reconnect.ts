import type { PeerRecord } from '@catalyst/routing/v2'
import type { Action } from '@catalyst/routing/v2'
import { Actions } from '@catalyst/routing/v2'
import { getLogger } from '@catalyst/telemetry'
import type { PeerTransport } from './transport.js'

const logger = getLogger(['catalyst', 'orchestrator', 'reconnect'])

/**
 * Manages automatic reconnection with exponential backoff.
 * On transport error, schedules reconnect attempts with increasing delays
 * capped at maxBackoffMs.
 */
export class ReconnectManager {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly attempts = new Map<string, number>()
  private readonly transport: PeerTransport
  private readonly dispatchFn: (action: Action) => Promise<unknown>
  private readonly maxBackoffMs: number

  constructor(opts: {
    transport: PeerTransport
    dispatchFn: (action: Action) => Promise<unknown>
    maxBackoffMs?: number
  }) {
    this.transport = opts.transport
    this.dispatchFn = opts.dispatchFn
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000
  }

  /**
   * Schedule a reconnect attempt for the given peer.
   * Uses exponential backoff: 1s, 2s, 4s, 8s, ... capped at maxBackoffMs.
   * If a reconnect is already scheduled for this peer, this call is a no-op.
   */
  scheduleReconnect(peer: PeerRecord): void {
    if (this.timers.has(peer.name)) return // already scheduled

    const attempt = (this.attempts.get(peer.name) ?? 0) + 1
    this.attempts.set(peer.name, attempt)

    const delay = Math.min(1000 * Math.pow(2, attempt - 1), this.maxBackoffMs)

    logger.info('Scheduling reconnect to {peerName} (attempt {attempt}, delay {delayMs}ms)', {
      'event.name': 'peer.reconnect.scheduled',
      'catalyst.orchestrator.peer.name': peer.name,
      'catalyst.orchestrator.reconnect.attempt': attempt,
      'catalyst.orchestrator.reconnect.delay_ms': delay,
    })

    const timer = setTimeout(async () => {
      this.timers.delete(peer.name)
      if (!peer.peerToken) {
        logger.warn('Skipping reconnect to {peerName}: no peer token available', {
          'event.name': 'peer.reconnect.skipped',
          'catalyst.orchestrator.peer.name': peer.name,
        })
        return
      }
      try {
        await this.transport.openPeer(peer, peer.peerToken)
        logger.info('Reconnect to {peerName} succeeded (attempt {attempt})', {
          'event.name': 'peer.reconnect.succeeded',
          'catalyst.orchestrator.peer.name': peer.name,
          'catalyst.orchestrator.reconnect.attempt': attempt,
        })
        // Success — dispatch InternalProtocolConnected to trigger full route sync
        await this.dispatchFn({
          action: Actions.InternalProtocolConnected,
          data: { peerInfo: { name: peer.name, domains: peer.domains } },
        })
        this.attempts.delete(peer.name) // reset attempt counter on success
      } catch (error) {
        logger.warn('Reconnect to {peerName} failed (attempt {attempt}), will retry', {
          'event.name': 'peer.reconnect.failed',
          'catalyst.orchestrator.peer.name': peer.name,
          'catalyst.orchestrator.reconnect.attempt': attempt,
          error,
        })
        // Failed — schedule next attempt
        this.scheduleReconnect(peer)
      }
    }, delay)

    this.timers.set(peer.name, timer)
  }

  /**
   * Cancel any pending reconnect for the given peer and reset its attempt counter.
   */
  cancelReconnect(peerName: string): void {
    const timer = this.timers.get(peerName)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(peerName)
    }
    this.attempts.delete(peerName)
  }

  /**
   * Cancel all pending reconnects and reset all attempt counters.
   */
  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.attempts.clear()
  }

  /** Number of peers with a pending reconnect timer. */
  get pendingCount(): number {
    return this.timers.size
  }
}
