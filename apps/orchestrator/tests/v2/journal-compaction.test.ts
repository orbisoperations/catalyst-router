import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryActionLog, Actions } from '@catalyst/routing/v2'
import type { ActionLog } from '@catalyst/routing/v2'
import type { RouteTable } from '@catalyst/routing/v2'
import { CompactionManager } from '../../src/v2/compaction.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NODE_ID = 'node-a'

function makeState(routeCount: number): RouteTable {
  const routes = new Map(
    Array.from({ length: routeCount }, (_, i) => [
      `route-${i}`,
      {
        name: `route-${i}`,
        protocol: 'http' as const,
        endpoint: `http://route-${i}:8080`,
      },
    ] as const)
  )
  return {
    local: { routes },
    internal: { peers: new Map(), routes: new Map() },
  }
}

function appendN(journal: ActionLog, count: number): void {
  for (let i = 0; i < count; i++) {
    journal.append(
      {
        action: Actions.LocalRouteCreate,
        data: { name: `route-${i}`, protocol: 'http' as const, endpoint: `http://r${i}:8080` },
      },
      NODE_ID
    )
  }
}

// ---------------------------------------------------------------------------
// Snapshot round-trip (InMemoryActionLog)
// ---------------------------------------------------------------------------

describe('InMemoryActionLog snapshot', () => {
  it('getSnapshot returns undefined when no snapshot exists', () => {
    const journal = new InMemoryActionLog()
    expect(journal.getSnapshot()).toBeUndefined()
  })

  it('round-trips a snapshot', () => {
    const journal = new InMemoryActionLog()
    appendN(journal, 5)
    const state = makeState(2)

    journal.snapshot(5, state)

    const snap = journal.getSnapshot()
    expect(snap).toBeDefined()
    expect(snap!.atSeq).toBe(5)
    expect(snap!.state).toEqual(state)
    expect(snap!.takenAt).toBeTruthy()
  })

  it('overwrites previous snapshot', () => {
    const journal = new InMemoryActionLog()
    appendN(journal, 10)
    journal.snapshot(5, makeState(1))
    journal.snapshot(10, makeState(2))

    const snap = journal.getSnapshot()
    expect(snap!.atSeq).toBe(10)
    expect((snap!.state as unknown as { local: { routes: Map<string, unknown> } }).local.routes.size).toBe(2)
  })

  it('prune removes entries before the given seq', () => {
    const journal = new InMemoryActionLog()
    appendN(journal, 10)

    const removed = journal.prune(8)
    expect(removed).toBe(7) // seqs 1-7 removed
    expect(journal.replay()).toHaveLength(3) // seqs 8, 9, 10 remain
  })

  it('replay(afterSeq) returns only tail entries', () => {
    const journal = new InMemoryActionLog()
    appendN(journal, 10)

    const tail = journal.replay(7)
    expect(tail).toHaveLength(3) // seqs 8, 9, 10
    expect(tail[0].seq).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// CompactionManager
// ---------------------------------------------------------------------------

describe('CompactionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips compaction when journal is empty', async () => {
    const journal = new InMemoryActionLog()
    const mgr = new CompactionManager({
      journal,
      getState: () => makeState(0),
      minEntries: 10,
    })

    const result = await mgr.compact()

    expect(result.skipped).toBe(true)
    if (result.skipped) expect(result.reason).toContain('empty')
  })

  it('skips compaction when entries below threshold', async () => {
    const journal = new InMemoryActionLog()
    appendN(journal, 5)
    const mgr = new CompactionManager({
      journal,
      getState: () => makeState(5),
      minEntries: 10,
    })

    const result = await mgr.compact()

    expect(result.skipped).toBe(true)
    if (result.skipped) expect(result.reason).toContain('5 entries')
  })

  it('compacts when entries exceed threshold', async () => {
    const journal = new InMemoryActionLog()
    appendN(journal, 20)
    const state = makeState(20)
    const mgr = new CompactionManager({
      journal,
      getState: () => state,
      minEntries: 10,
      tailSize: 5,
    })

    const result = await mgr.compact()

    expect(result.skipped).toBe(false)
    if (!result.skipped) {
      expect(result.snapshotAtSeq).toBe(20)
      expect(result.pruned).toBeGreaterThan(0)
    }

    // Verify snapshot was written
    const snap = journal.getSnapshot()
    expect(snap).toBeDefined()
    expect(snap!.atSeq).toBe(20)

    // Verify tail entries remain
    const remaining = journal.replay()
    expect(remaining.length).toBeLessThanOrEqual(5)
  })

  it('considers entries since last snapshot for threshold', async () => {
    const journal = new InMemoryActionLog()
    appendN(journal, 50)
    const state = makeState(50)

    // First compaction
    const mgr = new CompactionManager({
      journal,
      getState: () => state,
      minEntries: 10,
      tailSize: 5,
    })
    await mgr.compact()

    // Add a few more entries (below threshold)
    for (let i = 50; i < 55; i++) {
      journal.append(
        {
          action: Actions.LocalRouteCreate,
          data: { name: `route-${i}`, protocol: 'http' as const, endpoint: `http://r${i}:8080` },
        },
        NODE_ID
      )
    }

    const result = await mgr.compact()
    expect(result.skipped).toBe(true)
  })

  it('starts and stops periodic timer', () => {
    const journal = new InMemoryActionLog()
    const mgr = new CompactionManager({
      journal,
      getState: () => makeState(0),
      intervalMs: 60_000,
    })

    expect(mgr.isRunning).toBe(false)
    mgr.start()
    expect(mgr.isRunning).toBe(true)

    mgr.stop()
    expect(mgr.isRunning).toBe(false)
  })

  it('does not start when intervalMs is 0', () => {
    const journal = new InMemoryActionLog()
    const mgr = new CompactionManager({
      journal,
      getState: () => makeState(0),
      intervalMs: 0,
    })

    mgr.start()
    expect(mgr.isRunning).toBe(false)
  })

  it('calls compact on timer tick', async () => {
    const journal = new InMemoryActionLog()
    appendN(journal, 100)
    const mgr = new CompactionManager({
      journal,
      getState: () => makeState(100),
      intervalMs: 1000,
      minEntries: 10,
      tailSize: 5,
    })

    mgr.start()
    expect(journal.getSnapshot()).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1000)

    expect(journal.getSnapshot()).toBeDefined()
    mgr.stop()
  })

  it('start is idempotent', () => {
    const journal = new InMemoryActionLog()
    const mgr = new CompactionManager({
      journal,
      getState: () => makeState(0),
      intervalMs: 1000,
    })

    mgr.start()
    mgr.start() // second call should be no-op
    expect(mgr.isRunning).toBe(true)
    mgr.stop()
  })
})
