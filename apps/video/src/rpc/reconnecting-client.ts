import { EventEmitter } from 'node:events'

/**
 * Reconnecting RPC client wrapper with exponential backoff.
 *
 * Re-minting the DATA_CUSTODIAN token on reconnect is required because the
 * orchestrator loses all RPC session state on restart — the old
 * DataChannelClient is a dead object. Without re-mint, all route operations
 * fail silently. Ref: FR-002g.
 *
 * Follows the same pattern as ReconnectManager in
 * apps/orchestrator/src/v2/reconnect.ts — exponential backoff with attempt
 * reset on success.
 */

export interface ReconnectingClientOptions {
  /** Function to establish a new connection and return a client. */
  connect: () => Promise<unknown>
  /** Function to mint a fresh DATA_CUSTODIAN token. */
  mintToken: () => Promise<string>
  /** Function to run reconciliation after reconnect. */
  reconcile: () => Promise<void>
  /** Initial backoff delay in ms (default: 1000). */
  initialBackoffMs?: number
  /** Maximum backoff delay in ms (default: 60000). */
  maxBackoffMs?: number
}

interface ReconnectingClientEvents {
  connected: []
  disconnected: []
  reconnecting: [attempt: number, delayMs: number]
  reconciled: []
  error: [error: Error]
}

export class ReconnectingClient extends EventEmitter<ReconnectingClientEvents> {
  private _client: unknown = null
  private _connected = false
  private _stopped = false
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly connect: () => Promise<unknown>
  private readonly mintToken: () => Promise<string>
  private readonly reconcile: () => Promise<void>
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number

  constructor(options: ReconnectingClientOptions) {
    super()
    this.connect = options.connect
    this.mintToken = options.mintToken
    this.reconcile = options.reconcile
    this.initialBackoffMs = options.initialBackoffMs ?? 1000
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000
  }

  get client(): unknown {
    return this._client
  }

  get connected(): boolean {
    return this._connected
  }

  async start(): Promise<void> {
    this._stopped = false
    this.attempt = 0
    await this.doConnect()
  }

  stop(): void {
    this._stopped = true
    this._connected = false
    this._client = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /** Called by the transport layer when the connection drops. */
  onDisconnect(): void {
    if (this._stopped) return
    this._connected = false
    this._client = null
    this.emit('disconnected')
    this.scheduleReconnect()
  }

  private async doConnect(): Promise<void> {
    if (this._stopped) return

    try {
      await this.mintToken()
      this._client = await this.connect()
      this._connected = true
      this.attempt = 0
      this.emit('connected')

      await this.reconcile()
      this.emit('reconciled')
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this._stopped) return

    this.attempt++
    const delay = Math.min(this.initialBackoffMs * Math.pow(2, this.attempt - 1), this.maxBackoffMs)

    this.emit('reconnecting', this.attempt, delay)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.doConnect().catch(() => {
        // Errors are already handled in doConnect via emit('error')
      })
    }, delay)
  }
}
