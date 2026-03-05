import type { PeerRecord } from '@catalyst/routing/v2'
import type { z } from 'zod'
import type { UpdateMessageSchema } from '@catalyst/routing/v2'

export type UpdateMessage = z.infer<typeof UpdateMessageSchema>

/**
 * Abstraction over peer-to-peer communication.
 * Production: WebSocket RPC. Tests: MockPeerTransport.
 */
export interface PeerTransport {
  sendUpdate(peer: PeerRecord, message: UpdateMessage): Promise<void>
  sendKeepalive(peer: PeerRecord): Promise<void>
  openPeer(peer: PeerRecord, token: string): Promise<void>
  closePeer(peer: PeerRecord, code: number, reason?: string): Promise<void>
}

export type TransportCall =
  | { method: 'sendUpdate'; peer: PeerRecord; message: UpdateMessage }
  | { method: 'sendKeepalive'; peer: PeerRecord }
  | { method: 'openPeer'; peer: PeerRecord; token: string }
  | { method: 'closePeer'; peer: PeerRecord; code: number; reason?: string }

/**
 * Mock transport that records all calls for test assertions.
 * Can be used in unit and integration tests to verify orchestrator behaviour
 * without a real WebSocket connection.
 */
export class MockPeerTransport implements PeerTransport {
  readonly calls: TransportCall[] = []
  private _shouldFail = false

  /** Make all subsequent calls throw (for error path testing) */
  setShouldFail(fail: boolean): void {
    this._shouldFail = fail
  }

  async sendUpdate(peer: PeerRecord, message: UpdateMessage): Promise<void> {
    this.calls.push({ method: 'sendUpdate', peer, message })
    if (this._shouldFail) throw new Error('Transport failure')
  }

  async sendKeepalive(peer: PeerRecord): Promise<void> {
    this.calls.push({ method: 'sendKeepalive', peer })
    if (this._shouldFail) throw new Error('Transport failure')
  }

  async openPeer(peer: PeerRecord, token: string): Promise<void> {
    this.calls.push({ method: 'openPeer', peer, token })
    if (this._shouldFail) throw new Error('Transport failure')
  }

  async closePeer(peer: PeerRecord, code: number, reason?: string): Promise<void> {
    this.calls.push({ method: 'closePeer', peer, code, reason })
    if (this._shouldFail) throw new Error('Transport failure')
  }

  /** Return all recorded calls for a given method name */
  getCallsFor(method: TransportCall['method']): TransportCall[] {
    return this.calls.filter((c) => c.method === method)
  }

  /** Clear recorded calls and reset failure flag */
  reset(): void {
    this.calls.length = 0
    this._shouldFail = false
  }
}
