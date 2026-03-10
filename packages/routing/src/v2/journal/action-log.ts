import type { Action } from '../schema.js'
import type { RouteTable } from '../state.js'

export type ActionLogEntry = {
  seq: number
  action: Action
  nodeId: string
  recorded_at: string
}

export type Snapshot = {
  atSeq: number
  state: RouteTable
  takenAt: string
}

/**
 * Append-only action log interface with snapshot-based compaction.
 *
 * Core operations (append, replay, lastSeq) record and replay actions.
 * Compaction operations (snapshot, getSnapshot, prune) enable periodic
 * snapshot + truncate to bound journal growth.
 *
 * Recovery flow:
 *   1. getSnapshot() → if present, use as initial state
 *   2. replay(snapshot.atSeq) → replay only the tail entries
 *   3. Apply each entry via plan/commit on a temporary RIB
 */
export interface ActionLog {
  /** Append a committed action. Returns the assigned sequence number. */
  append(action: Action, nodeId: string): number

  /** Replay actions after the given sequence number (exclusive). Returns entries in order. */
  replay(afterSeq?: number): ActionLogEntry[]

  /** Sequence number of the last appended action, or 0 if empty. */
  lastSeq(): number

  /** Write a snapshot of the current state at the given sequence number. */
  snapshot(atSeq: number, state: RouteTable): void

  /** Read the most recent snapshot, or undefined if none exists. */
  getSnapshot(): Snapshot | undefined

  /**
   * Delete journal entries with seq < beforeSeq.
   * Returns the number of entries deleted.
   */
  prune(beforeSeq: number): number
}
