import type { CatalystConfig } from '@catalyst/config'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import type { Hono } from 'hono'

/** Lifecycle state for a CatalystService. */
export type ServiceState = 'created' | 'initializing' | 'ready' | 'shutting_down' | 'stopped'

/** Options accepted by the CatalystService constructor. */
export interface CatalystServiceOptions {
  /** Pre-loaded CatalystConfig. */
  readonly config: CatalystConfig
  /**
   * Pre-built telemetry. If provided, the base class skips TelemetryBuilder.build()
   * and does NOT shut it down — the caller owns the lifecycle.
   * Useful for testing or when composing services that share one telemetry instance.
   */
  readonly telemetry?: ServiceTelemetry
}

/** Static metadata about a service. */
export interface ServiceInfo {
  readonly name: string
  readonly version: string
}

/** The public contract of a CatalystService for composition consumers. */
export interface ICatalystService {
  /** Hono route group containing all service routes. */
  readonly handler: Hono
  /** Service metadata. */
  readonly info: ServiceInfo
  /** The unified config this service was created with. */
  readonly config: CatalystConfig
  /** Telemetry context for this service. */
  readonly telemetry: ServiceTelemetry
  /** Current lifecycle state. */
  readonly state: ServiceState
  /** Initialize the service (telemetry + app-specific). */
  initialize(): Promise<void>
  /** Gracefully shut down. */
  shutdown(): Promise<void>
}
