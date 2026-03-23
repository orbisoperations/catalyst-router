import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { SqliteActionLog } from '../../../src/v2/journal/sqlite-action-log.js'
import { Actions } from '../../../src/v2/action-types.js'
import type { Action } from '../../../src/v2/schema.js'

const makeAction = (name: string): Action => ({
  action: Actions.LocalRouteCreate,
  data: { name, protocol: 'http' as const },
})

describe('SqliteActionLog', () => {
  let db: Database.Database
  let log: SqliteActionLog

  beforeEach(() => {
    db = new Database(':memory:')
    log = new SqliteActionLog(db)
  })

  it('creates table on construction', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='action_log'")
      .all()
    expect(tables).toHaveLength(1)
  })

  it('returns incrementing sequence numbers', () => {
    expect(log.append(makeAction('a'), 'node-1')).toBe(1)
    expect(log.append(makeAction('b'), 'node-1')).toBe(2)
    expect(log.append(makeAction('c'), 'node-1')).toBe(3)
  })

  it('replays all actions in order', () => {
    log.append(makeAction('a'), 'node-1')
    log.append(makeAction('b'), 'node-1')
    const entries = log.replay()
    expect(entries).toHaveLength(2)
    expect(entries[0].seq).toBe(1)
    expect(entries[1].seq).toBe(2)
    expect(entries[0].nodeId).toBe('node-1')
  })

  it('replays actions after given seq', () => {
    log.append(makeAction('a'), 'node-1')
    log.append(makeAction('b'), 'node-1')
    log.append(makeAction('c'), 'node-1')
    const entries = log.replay(1)
    expect(entries).toHaveLength(2)
    expect(entries[0].seq).toBe(2)
  })

  it('returns empty array on empty log', () => {
    expect(log.replay()).toEqual([])
  })

  it('returns 0 for lastSeq on empty log', () => {
    expect(log.lastSeq()).toBe(0)
  })

  it('returns highest seq after appends', () => {
    log.append(makeAction('a'), 'node-1')
    log.append(makeAction('b'), 'node-1')
    expect(log.lastSeq()).toBe(2)
  })

  it('round-trips action data through JSON', () => {
    const action: Action = {
      action: Actions.LocalPeerCreate,
      data: { name: 'peer-x', domains: ['example.com'] },
    }
    log.append(action, 'node-1')
    const [entry] = log.replay()
    expect(entry.action).toEqual(action)
    expect(entry.action.action).toBe(Actions.LocalPeerCreate)
  })

  it('stores action type in separate column', () => {
    log.append(makeAction('svc'), 'node-1')
    const row = db.prepare('SELECT action FROM action_log WHERE seq = 1').get() as {
      action: string
    }
    expect(row.action).toBe(Actions.LocalRouteCreate)
  })

  it('stores multiple action types correctly', () => {
    const create: Action = {
      action: Actions.LocalRouteCreate,
      data: { name: 'svc', protocol: 'http' },
    }
    const tick: Action = { action: Actions.Tick, data: { now: 12345 } }
    log.append(create, 'node-1')
    log.append(tick, 'node-1')
    const entries = log.replay()
    expect(entries[0].action.action).toBe(Actions.LocalRouteCreate)
    expect(entries[1].action.action).toBe(Actions.Tick)
  })

  it('has recorded_at on entries', () => {
    log.append(makeAction('svc'), 'node-1')
    const [entry] = log.replay()
    expect(entry.recorded_at).toBeTruthy()
    // Should be ISO-ish format from SQLite
    expect(entry.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}/)
  })
})
