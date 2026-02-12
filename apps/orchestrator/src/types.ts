import type { Action, RouteTable } from '@catalyst/routing'
import { z } from 'zod'

import { NodeConfigSchema } from '@catalyst/config'

export const OrchestratorConfigSchema = z.object({
  node: NodeConfigSchema.extend({
    endpoint: z.string(), // Orchestrator requires an endpoint for its own node
  }),
  gqlGatewayConfig: z
    .object({
      endpoint: z.string(),
    })
    .optional(),
  holdTime: z.number().min(3).default(180).optional(), // BGP hold time in seconds
})

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>

export type StateResult =
  | { success: true; state: RouteTable; action: Action; data?: unknown; nextActions?: Action[] }
  | { success: false; error: string; state?: RouteTable }

export type NotificationResult =
  | { success: true; nextActions?: Action[] }
  | { success: false; error: string; nextActions?: Action[] }

/**
 * State plugins are responsible for validating actions and updating the internal state.
 * They must not perform external I/O.
 */
export interface StatePlugin {
  name: string

  /**
   * Processes an action and returns the new state.
   * returning { success: false } stops the pipeline and reverts.
   */
  apply(action: Action, state: RouteTable): Promise<StateResult>
}

export type Dispatcher = (action: Action) => Promise<ApplyActionResult>

/**
 * Notification plugins observe the transition from originalState to newState
 * and perform side effects.
 */
export interface NotificationPlugin {
  name: string

  /**
   * Reacts to a completed state change.
   * These are executed sequentially after the State implementation is finalized.
   */
  notify(
    action: Action,
    originalState: RouteTable,
    newState: RouteTable,
    dispatch: Dispatcher
  ): Promise<NotificationResult>
}

export type ApplyActionResult = {
  success: boolean
  results: unknown[]
  error?: string
}
