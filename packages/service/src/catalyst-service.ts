import type { CatalystConfig } from '@catalyst/config'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import { TelemetryBuilder, shutdownTelemetry } from '@catalyst/telemetry'
import type { Hono } from 'hono'
import type {
  CatalystServiceOptions,
  ICatalystService,
  ServiceInfo,
  ServiceState,
} from './types.js'

/**
 * Abstract base class for all Catalyst services.
 *
 * Provides:
 * - Unified config injection via `CatalystConfig`
 * - Automatic OpenTelemetry setup with sane defaults (or pre-built injection)
 * - Lifecycle management: create → initialize → ready → shutdown
 *
 * Subclasses must:
 * - Define `info` (service name and version)
 * - Define `handler` (a Hono route group with all service routes)
 * - Override `onInitialize()` to build domain objects and register routes on `handler`
 * - Optionally override `onShutdown()` for cleanup
 *
 * The service does NOT own the HTTP server — use `catalystHonoServer()` to wrap
 * the handler in a server with standard lifecycle management.
 *
 * @example
 * ```ts
 * class AuthService extends CatalystService {
 *   readonly info = { name: 'auth', version: '0.0.0' }
 *   readonly handler = new Hono()
 *
 *   protected async onInitialize(): Promise<void> {
 *     this.handler.route('/rpc', createAuthRpcHandler(this.rpcServer))
 *   }
 * }
 *
 * const auth = await AuthService.create({ config })
 * catalystHonoServer(auth.handler, { services: [auth] }).start()
 * ```
 */
export abstract class CatalystService implements ICatalystService {
  readonly config: CatalystConfig
  private _telemetry: ServiceTelemetry | undefined
  private _state: ServiceState = 'created'
  private readonly _prebuiltTelemetry: ServiceTelemetry | undefined

  /** Subclasses must provide service metadata. */
  abstract readonly info: ServiceInfo

  /** Hono route group with all service routes. Populated during onInitialize(). */
  abstract readonly handler: Hono

  protected constructor(options: CatalystServiceOptions) {
    this.config = options.config
    this._prebuiltTelemetry = options.telemetry
  }

  /** Telemetry context. Throws if accessed before initialize(). */
  get telemetry(): ServiceTelemetry {
    if (!this._telemetry) {
      throw new Error(
        `Service "${this.info.name}" not initialized. Call initialize() or use static create().`
      )
    }
    return this._telemetry
  }

  /** Current lifecycle state. */
  get state(): ServiceState {
    return this._state
  }

  /**
   * Initialize the service. Must be called before the handler is used.
   *
   * 1. Builds telemetry (or uses pre-built)
   * 2. Calls onInitialize() for app-specific async setup
   * 3. Sets state to 'ready'
   */
  async initialize(): Promise<void> {
    if (this._state !== 'created') {
      throw new Error(
        `Cannot initialize service "${this.info.name}" in state "${this._state}". Expected "created".`
      )
    }
    this._state = 'initializing'

    try {
      // Build or reuse telemetry
      if (this._prebuiltTelemetry) {
        this._telemetry = this._prebuiltTelemetry
      } else {
        try {
          this._telemetry = await new TelemetryBuilder(this.info.name)
            .withLogger({ category: ['catalyst', this.info.name] })
            .withMetrics()
            .withTracing()
            .withRpcInstrumentation()
            .build()
        } catch {
          this._telemetry = TelemetryBuilder.noop(this.info.name)
        }
      }

      // Subclass-specific async initialization
      await this.onInitialize()

      this._state = 'ready'
      this.telemetry.logger.info`${this.info.name} v${this.info.version} initialized`
    } catch (err) {
      this._state = 'stopped'
      throw err
    }
  }

  /**
   * Gracefully shut down the service.
   *
   * 1. Calls onShutdown() for app-specific cleanup
   * 2. Shuts down telemetry (only if we own it)
   */
  async shutdown(): Promise<void> {
    if (this._state !== 'ready') return
    this._state = 'shutting_down'

    try {
      this.telemetry.logger.info`${this.info.name} shutting down`
      await this.onShutdown()
    } finally {
      // Only shut down telemetry if we built it (not pre-built / shared)
      if (!this._prebuiltTelemetry) {
        await shutdownTelemetry()
      }
      this._state = 'stopped'
    }
  }

  // --- Protected hooks for subclasses ---

  /**
   * App-specific async initialization. Called after telemetry is available.
   * Override this to create domain objects and register routes on `this.handler`.
   */
  protected async onInitialize(): Promise<void> {
    // Default: no-op
  }

  /**
   * App-specific shutdown logic. Called before telemetry shutdown.
   * Override this to close connection pools, clear intervals, etc.
   */
  protected async onShutdown(): Promise<void> {
    // Default: no-op
  }

  // --- Static factory ---

  /**
   * Create and initialize a service in one call.
   *
   * @example
   * ```ts
   * const auth = await AuthService.create({ config })
   * ```
   */
  static async create<T extends CatalystService>(
    this: new (options: CatalystServiceOptions) => T,
    options: CatalystServiceOptions
  ): Promise<T> {
    const instance = new this(options)
    await instance.initialize()
    return instance
  }
}
