import type Database from 'better-sqlite3'
import type { Action } from '../schema.js'
import type { RouteTable } from '../state.js'
import type { ActionLog, ActionLogEntry, Snapshot } from './action-log.js'

const CREATE_ACTION_LOG = `
CREATE TABLE IF NOT EXISTS action_log (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  action    TEXT    NOT NULL,
  data      TEXT    NOT NULL,
  node_id   TEXT    NOT NULL
)`

const CREATE_SNAPSHOT = `
CREATE TABLE IF NOT EXISTS snapshot (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  at_seq     INTEGER NOT NULL,
  state_json TEXT    NOT NULL,
  taken_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
)`

/**
 * SQLite-backed action log with snapshot-based compaction.
 * Uses better-sqlite3 with WAL mode per ADR-0012.
 *
 * Compaction flow (driven by CompactionManager):
 *   1. snapshot(atSeq, state) — write current state as a singleton row
 *   2. prune(beforeSeq) — delete old journal entries
 *   3. vacuum() — reclaim disk space and truncate WAL
 *
 * SECURITY NOTE: Action payloads are stored verbatim, including credential
 * fields like `peerToken` on LocalPeerCreate/Update actions. The journal file
 * must be treated as sensitive and protected at the filesystem/volume level.
 * A future enhancement should scrub credential fields before serialisation.
 */
export class SqliteActionLog implements ActionLog {
  private readonly db: Database.Database
  private readonly insertStmt: Database.Statement
  private readonly replayStmt: Database.Statement
  private readonly lastSeqStmt: Database.Statement
  private readonly snapshotStmt: Database.Statement
  private readonly getSnapshotStmt: Database.Statement
  private readonly pruneStmt: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('wal_autocheckpoint = 0')
    this.db.pragma('journal_size_limit = 6291456')
    this.db.exec(CREATE_ACTION_LOG)
    this.db.exec(CREATE_SNAPSHOT)

    this.insertStmt = this.db.prepare(
      'INSERT INTO action_log (action, data, node_id) VALUES (?, ?, ?)'
    )
    this.replayStmt = this.db.prepare(
      'SELECT seq, recorded_at, action, data, node_id FROM action_log WHERE seq > ? ORDER BY seq ASC'
    )
    this.lastSeqStmt = this.db.prepare('SELECT MAX(seq) as max_seq FROM action_log')

    this.snapshotStmt = this.db.prepare(`
      INSERT INTO snapshot (id, at_seq, state_json)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        at_seq     = excluded.at_seq,
        state_json = excluded.state_json,
        taken_at   = strftime('%Y-%m-%dT%H:%M:%f', 'now')
    `)
    this.getSnapshotStmt = this.db.prepare(
      'SELECT at_seq, state_json, taken_at FROM snapshot WHERE id = 1'
    )
    this.pruneStmt = this.db.prepare('DELETE FROM action_log WHERE seq < ?')
  }

  append(action: Action, nodeId: string): number {
    const result = this.insertStmt.run(action.action, JSON.stringify(action), nodeId)
    return Number(result.lastInsertRowid)
  }

  replay(afterSeq = 0): ActionLogEntry[] {
    const rows = this.replayStmt.all(afterSeq) as Array<{
      seq: number
      recorded_at: string
      action: string
      data: string
      node_id: string
    }>
    return rows.map((row) => ({
      seq: row.seq,
      action: JSON.parse(row.data) as Action,
      nodeId: row.node_id,
      recorded_at: row.recorded_at,
    }))
  }

  lastSeq(): number {
    const row = this.lastSeqStmt.get() as { max_seq: number | null }
    return row.max_seq ?? 0
  }

  snapshot(atSeq: number, state: RouteTable): void {
    this.snapshotStmt.run(atSeq, JSON.stringify(state))
  }

  getSnapshot(): Snapshot | undefined {
    const row = this.getSnapshotStmt.get() as
      | { at_seq: number; state_json: string; taken_at: string }
      | undefined
    if (row === undefined) return undefined
    return {
      atSeq: row.at_seq,
      state: JSON.parse(row.state_json) as RouteTable,
      takenAt: row.taken_at,
    }
  }

  prune(beforeSeq: number): number {
    const result = this.pruneStmt.run(beforeSeq)
    return result.changes
  }

  /**
   * Reclaim disk space after pruning. Runs VACUUM followed by a
   * WAL TRUNCATE checkpoint. Call sparingly — blocks the event loop.
   */
  vacuum(): void {
    this.db.exec('VACUUM')
    this.db.pragma('wal_checkpoint(TRUNCATE)')
  }
}
