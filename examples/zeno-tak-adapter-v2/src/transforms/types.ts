/* eslint-disable @typescript-eslint/no-explicit-any */

import type { CoT } from '@tak-ps/node-tak'
import type { SubscriptionConfig } from '../config'

/**
 * Logger interface for transforms.
 */
export interface TransformLogger {
  debug(message: string, ...args: any[]): void
  info(message: string, ...args: any[]): void
  warn(message: string, ...args: any[]): void
  error(message: string, ...args: any[]): void
}

/**
 * Context passed to transform functions.
 */
export interface TransformContext {
  /** Full Zenoh topic the message was received on */
  topic: string
  /** Timestamp when the message was received */
  timestamp: Date
  /** Subscription configuration (includes overrides) */
  config: SubscriptionConfig
  /** Scoped logger for this transform */
  logger: TransformLogger
  /** Shared cache across invocations */
  cache: Map<string, any>
}

/**
 * Interface that all transform plugins must implement.
 */
export interface TransformPlugin {
  /** Unique name for the transform */
  name: string
  /** Optional version string */
  version?: string
  /** Optional description */
  description?: string

  /** Optional initialization hook */
  init?(config?: SubscriptionConfig): Promise<void>

  /** Optional payload validation */
  validate?(payload: unknown): boolean

  /**
   * Transform a payload into a CoT event.
   * Return null to skip/filter the message.
   */
  transform(payload: any, ctx: TransformContext): Promise<CoT | null>

  /** Optional cleanup hook */
  destroy?(): Promise<void>
}

/**
 * Create a scoped logger for a transform.
 */
export function createTransformLogger(
  transformName: string,
  logLevel: string = 'info'
): TransformLogger {
  const levels = ['error', 'warn', 'info', 'debug']
  const currentLevel = levels.indexOf(logLevel)
  const shouldLog = (level: string): boolean => {
    return levels.indexOf(level) <= currentLevel
  }

  return {
    debug: (message: string, ...args: any[]) => {
      if (shouldLog('debug')) console.debug(`[${transformName}] ${message}`, ...args)
    },
    info: (message: string, ...args: any[]) => {
      if (shouldLog('info')) console.info(`[${transformName}] ${message}`, ...args)
    },
    warn: (message: string, ...args: any[]) => {
      if (shouldLog('warn')) console.warn(`[${transformName}] ${message}`, ...args)
    },
    error: (message: string, ...args: any[]) => {
      if (shouldLog('error')) console.error(`[${transformName}] ${message}`, ...args)
    },
  }
}
