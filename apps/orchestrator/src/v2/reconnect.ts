import type { PeerRecord } from '@catalyst/routing/v2'
import type { Action } from '@catalyst/routing/v2'
import { Actions } from '@catalyst/routing/v2'
import type { PeerTransport } from './transport.js'

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
  private nodeToken: string | undefined

  constructor(opts: {
    transport: PeerTransport
    dispatchFn: (action: Action) => Promise<unknown>
    nodeToken?: string
    maxBackoffMs?: number
  }) {
    this.transport = opts.transport
    this.dispatchFn = opts.dispatchFn
    this.nodeToken = opts.nodeToken
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000
  }

  setNodeToken(token: string): void {
    this.nodeToken = token
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

    const timer = setTimeout(async () => {
      this.timers.delete(peer.name)
      try {
        await this.transport.openPeer(peer, this.nodeToken ?? '')
        // Success — dispatch InternalProtocolOpen to trigger sync
        await this.dispatchFn({
          action: Actions.InternalProtocolOpen,
          data: { peerInfo: { name: peer.name, domains: peer.domains } },
        })
        this.attempts.delete(peer.name) // reset attempt counter on success
      } catch {
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
