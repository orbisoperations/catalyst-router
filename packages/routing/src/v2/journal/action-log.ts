import type { Action } from '../schema.js'

export type ActionLogEntry = {
  seq: number
  action: Action
  nodeId: string
  recorded_at: string
}

/**
 * Append-only action log interface.
 * All state-changing actions are recorded for replay and auditability.
 */
export interface ActionLog {
  /** Append a committed action. Returns the assigned sequence number. */
  append(action: Action, nodeId: string): number

  /** Replay actions after the given sequence number (exclusive). Returns entries in order. */
  replay(afterSeq?: number): ActionLogEntry[]

  /** Sequence number of the last appended action, or 0 if empty. */
  lastSeq(): number
}
