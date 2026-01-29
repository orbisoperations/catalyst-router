import type { Action } from './schema.js'
import type { RouteTable } from './routing/state.js'
import { z } from 'zod'
import { PeerInfoSchema } from './routing/state.js'

export const OrchestratorConfigSchema = z.object({
  node: PeerInfoSchema,
  ibgp: z
    .object({
      secret: z.string().optional(),
    })
    .optional(),
  gqlGatewayConfig: z
    .object({
      endpoint: z.string(),
    })
    .optional(),
})

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>

export const AuthContextSchema = z.object({
  userId: z.string(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()).optional(),
})
export type AuthContext = z.infer<typeof AuthContextSchema>

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
  apply(action: Action, state: RouteTable, auth: AuthContext): Promise<StateResult>
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
    auth: AuthContext,
    dispatch: Dispatcher
  ): Promise<NotificationResult>
}

export type ApplyActionResult = {
  success: boolean
  results: unknown[]
  error?: string
}
