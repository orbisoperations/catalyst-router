import type Database from 'better-sqlite3'
import type { Action } from '../schema.js'
import type { ActionLog, ActionLogEntry } from './action-log.js'

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS action_log (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  action    TEXT    NOT NULL,
  data      TEXT    NOT NULL,
  node_id   TEXT    NOT NULL
)`

/**
 * SQLite-backed append-only action log.
 * Uses better-sqlite3 with WAL mode per ADR-0012.
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

  constructor(db: Database.Database) {
    this.db = db
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(CREATE_TABLE)

    this.insertStmt = this.db.prepare(
      'INSERT INTO action_log (action, data, node_id) VALUES (?, ?, ?)'
    )
    this.replayStmt = this.db.prepare(
      'SELECT seq, recorded_at, action, data, node_id FROM action_log WHERE seq > ? ORDER BY seq ASC'
    )
    this.lastSeqStmt = this.db.prepare('SELECT MAX(seq) as max_seq FROM action_log')
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
}
