import { describe, it, expect } from 'vitest'
import { InMemoryActionLog } from '../../../src/v2/journal/in-memory-action-log.js'
import { Actions } from '../../../src/v2/action-types.js'
import type { Action } from '../../../src/v2/schema.js'

const makeAction = (name: string): Action => ({
  action: Actions.LocalRouteCreate,
  data: { name, protocol: 'http' as const },
})

describe('InMemoryActionLog', () => {
  it('returns incrementing sequence numbers', () => {
    const log = new InMemoryActionLog()
    expect(log.append(makeAction('a'), 'node-1')).toBe(1)
    expect(log.append(makeAction('b'), 'node-1')).toBe(2)
    expect(log.append(makeAction('c'), 'node-1')).toBe(3)
  })

  it('replays all actions in order', () => {
    const log = new InMemoryActionLog()
    log.append(makeAction('a'), 'node-1')
    log.append(makeAction('b'), 'node-1')
    const entries = log.replay()
    expect(entries).toHaveLength(2)
    expect(entries[0].seq).toBe(1)
    expect(entries[1].seq).toBe(2)
    expect(entries[0].nodeId).toBe('node-1')
  })

  it('replays actions after given seq', () => {
    const log = new InMemoryActionLog()
    log.append(makeAction('a'), 'node-1')
    log.append(makeAction('b'), 'node-1')
    log.append(makeAction('c'), 'node-1')
    const entries = log.replay(1)
    expect(entries).toHaveLength(2)
    expect(entries[0].seq).toBe(2)
    expect(entries[1].seq).toBe(3)
  })

  it('returns empty array on empty log', () => {
    const log = new InMemoryActionLog()
    expect(log.replay()).toEqual([])
  })

  it('returns 0 for lastSeq on empty log', () => {
    const log = new InMemoryActionLog()
    expect(log.lastSeq()).toBe(0)
  })

  it('returns highest seq after appends', () => {
    const log = new InMemoryActionLog()
    log.append(makeAction('a'), 'node-1')
    log.append(makeAction('b'), 'node-1')
    expect(log.lastSeq()).toBe(2)
  })

  it('stores multiple action types correctly', () => {
    const log = new InMemoryActionLog()
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
})
