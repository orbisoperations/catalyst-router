import type { Action } from '../schema.js'
import type { ActionLog, ActionLogEntry } from './action-log.js'

/**
 * In-memory ActionLog for tests and development.
 * Not persistent — data lost on process restart.
 */
export class InMemoryActionLog implements ActionLog {
  private entries: ActionLogEntry[] = []
  private nextSeq = 1

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
}
