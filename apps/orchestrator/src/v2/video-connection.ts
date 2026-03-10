import type { VideoNotifier, StreamCatalog } from './video-notifier.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped'

export interface VideoConnectionManagerOptions {
  endpoint: string
  createSession: (url: string) => {
    getVideoClient: (dispatch: unknown) => Promise<{
      success: true
      client: {
        updateStreamCatalog: (catalog: StreamCatalog) => Promise<void>
        refreshToken: (token: string) => Promise<void>
      }
    }>
  }
  buildDispatchCapability: () => unknown
  onConnected: () => Promise<void>
  logger: { info(msg: string): void; warn(msg: string): void }
  backoff?: { initialDelayMs?: number; maxDelayMs?: number }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INITIAL_DELAY_MS = 1000
const DEFAULT_MAX_DELAY_MS = 30_000
const JITTER_FACTOR = 0.2
const BACKOFF_MULTIPLIER = 2

// ---------------------------------------------------------------------------
// VideoConnectionManager
// ---------------------------------------------------------------------------

interface VideoClient {
  updateStreamCatalog: (catalog: StreamCatalog) => Promise<void>
  refreshToken: (token: string) => Promise<void>
}

export class VideoConnectionManager implements VideoNotifier {
  private _status: ConnectionStatus = 'idle'
  private _client: VideoClient | undefined
  private _timer: ReturnType<typeof setTimeout> | undefined
  private _attempt = 0
  private _nodeToken: string | undefined

  private readonly endpoint: string
  private readonly createSession: VideoConnectionManagerOptions['createSession']
  private readonly buildDispatchCapability: () => unknown
  private readonly onConnectedCallback: () => Promise<void>
  private readonly logger: { info(msg: string): void; warn(msg: string): void }
  private readonly initialDelayMs: number
  private readonly maxDelayMs: number

  constructor(opts: VideoConnectionManagerOptions) {
    this.endpoint = opts.endpoint
    this.createSession = opts.createSession
    this.buildDispatchCapability = opts.buildDispatchCapability
    this.onConnectedCallback = opts.onConnected
    this.logger = opts.logger
    this.initialDelayMs = opts.backoff?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
    this.maxDelayMs = opts.backoff?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  }

  /** Current connection status. */
  get status(): ConnectionStatus {
    return this._status
  }

  /**
   * Begin connection. Transitions idle -> connecting and kicks off async
   * connect attempt without blocking the caller.
   */
  start(): void {
    if (this._status !== 'idle') return
    this.transition('connecting')
    void this.connect()
  }

  /**
   * Stop the manager. Cancels any pending reconnect timer, clears client,
   * and prevents any further scheduling.
   */
  stop(): void {
    this.clearTimer()
    this._client = undefined
    this.transition('stopped')
  }

  /**
   * Push a stream catalog to the video service.
   * If not connected or stopped, returns silently (FR-008 graceful degradation).
   * If the RPC call fails, triggers a reconnect cycle.
   */
  async pushCatalog(catalog: StreamCatalog): Promise<void> {
    if (this._status === 'stopped' || this._client === undefined) return

    try {
      await this._client.updateStreamCatalog(catalog)
    } catch {
      this.logger.warn('Video RPC failed during pushCatalog — scheduling reconnect')
      this._client = undefined
      this.scheduleReconnect()
    }
  }

  /**
   * Store a node token. If currently connected, pushes the token to the
   * video service immediately (fire-and-forget).
   */
  setNodeToken(token: string): void {
    this._nodeToken = token
    if (this._status === 'connected' && this._client !== undefined) {
      void this._client.refreshToken(token).catch(() => {
        this.logger.warn('Failed to push token refresh to video service')
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async connect(): Promise<void> {
    try {
      const session = this.createSession(this.endpoint)
      const dispatchCap = this.buildDispatchCapability()
      const result = await session.getVideoClient(dispatchCap)

      if (this._status === 'stopped') return

      this._client = result.client
      this._attempt = 0
      this.transition('connected')

      // Push token if we have one stored
      if (this._nodeToken !== undefined) {
        try {
          await this._client.refreshToken(this._nodeToken)
        } catch {
          this.logger.warn('Failed to push stored token on reconnect')
        }
      }

      await this.onConnectedCallback()
    } catch {
      if (this._status === 'stopped') return
      this.logger.warn('Video connection attempt failed — scheduling reconnect')
      this.scheduleReconnect()
    }
  }

  /**
   * Schedule a reconnect attempt with exponential backoff + jitter.
   * Idempotent — if a timer is already pending, this is a no-op (FR-010).
   */
  private scheduleReconnect(): void {
    if (this._status === 'stopped') return
    if (this._timer !== undefined) return // already scheduled

    this.transition('reconnecting')

    const delay = this.computeDelay()

    this._timer = setTimeout(() => {
      this._timer = undefined
      if (this._status === 'stopped') return
      this.transition('connecting')
      void this.connect()
    }, delay)
  }

  /**
   * Compute the next backoff delay with jitter.
   * Formula: min(initial * multiplier^attempt, max) * (1 - jitter + rand * 2 * jitter)
   */
  private computeDelay(): number {
    this._attempt++
    const baseDelay = Math.min(
      this.initialDelayMs * BACKOFF_MULTIPLIER ** (this._attempt - 1),
      this.maxDelayMs
    )
    const jitter = 1 - JITTER_FACTOR + Math.random() * 2 * JITTER_FACTOR
    return Math.round(baseDelay * jitter)
  }

  private clearTimer(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer)
      this._timer = undefined
    }
  }

  private transition(newStatus: ConnectionStatus): void {
    const oldStatus = this._status
    this._status = newStatus
    this.logger.info(`Video connection: ${oldStatus} -> ${newStatus}`)
  }
}
