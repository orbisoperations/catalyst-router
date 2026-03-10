import type { Action } from '../schema.js'
import type { RouteTable } from '../state.js'
import type { ActionLog, ActionLogEntry, Snapshot } from './action-log.js'

/**
 * In-memory ActionLog for tests and development.
 * Not persistent — data lost on process restart.
 * Compaction methods are functional but have no disk impact.
 */
export class InMemoryActionLog implements ActionLog {
  private entries: ActionLogEntry[] = []
  private nextSeq = 1
  private _snapshot: Snapshot | undefined

  append(action: Action, nodeId: string): number {
    const seq = this.nextSeq++
    this.entries.push({
      seq,
      action,
      nodeId,
      recorded_at: new Date().toISOString(),
    })
    return seq
  }

  replay(afterSeq = 0): ActionLogEntry[] {
    return this.entries.filter((e) => e.seq > afterSeq)
  }

  lastSeq(): number {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1].seq : 0
  }

  snapshot(atSeq: number, state: RouteTable): void {
    this._snapshot = {
      atSeq,
      state,
      takenAt: new Date().toISOString(),
    }
  }

  getSnapshot(): Snapshot | undefined {
    return this._snapshot
  }

  prune(beforeSeq: number): number {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.seq >= beforeSeq)
    return before - this.entries.length
  }
}
