/**
 * Integration test: SQLite journal durability and restart reconstruction.
 *
 * Verifies the full SQLite journal lifecycle that unit tests skip (they use InMemoryActionLog):
 * - Schema creation on first run
 * - Routes added via bus.dispatch() are durably written to SQLite
 * - Constructing a new OrchestratorServiceV2 with the same journalPath reconstructs state
 * - No double-append on replay
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OrchestratorServiceV2 } from '../../src/v2/service.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: OrchestratorConfig = {
  node: {
    name: 'node-a',
    endpoint: 'ws://node-a:4000',
    domains: ['journal.local'],
  },
}

const routeAlpha = {
  name: 'alpha',
  protocol: 'http' as const,
  endpoint: 'http://alpha:8080',
}

const routeBeta = {
  name: 'beta',
  protocol: 'http' as const,
  endpoint: 'http://beta:8080',
}

const peerB = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['journal.local'],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string
let journalPath: string

function freshJournalPath(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'catalyst-journal-'))
  journalPath = join(tmpDir, 'test-journal.db')
  return journalPath
}

function cleanup(): void {
  // SQLite WAL + SHM files
  for (const suffix of ['', '-wal', '-shm']) {
    const p = journalPath + suffix
    if (existsSync(p)) unlinkSync(p)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SQLite journal: durability and restart reconstruction', () => {
  afterEach(() => {
    cleanup()
  })

  it('creates the database file and schema on first construction', () => {
    const jp = freshJournalPath()

    expect(existsSync(jp)).toBe(false)
    const svc = new OrchestratorServiceV2({
      config,
      transport: new MockPeerTransport(),
      journalPath: jp,
    })
    void svc.stop()

    expect(existsSync(jp)).toBe(true)
  })

  it('restores local routes from SQLite journal after simulated restart', async () => {
    const jp = freshJournalPath()

    // Session 1: add routes
    const svc1 = new OrchestratorServiceV2({
      config,
      transport: new MockPeerTransport(),
      journalPath: jp,
    })

    await svc1.bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })
    await svc1.bus.dispatch({ action: Actions.LocalRouteCreate, data: routeBeta })

    expect(svc1.bus.state.local.routes).toHaveLength(2)
    await svc1.stop()

    // Session 2: fresh service with same journal
    const svc2 = new OrchestratorServiceV2({
      config,
      transport: new MockPeerTransport(),
      journalPath: jp,
    })

    expect(svc2.bus.state.local.routes).toHaveLength(2)
    const names = svc2.bus.state.local.routes.map((r) => r.name).sort()
    expect(names).toEqual(['alpha', 'beta'])

    await svc2.stop()
  })

  it('restores peer state from SQLite journal after restart', async () => {
    const jp = freshJournalPath()

    // Session 1: add peer
    const svc1 = new OrchestratorServiceV2({
      config,
      transport: new MockPeerTransport(),
      journalPath: jp,
    })

    await svc1.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    expect(svc1.bus.state.internal.peers).toHaveLength(1)
    await svc1.stop()

    // Session 2: peer should be restored
    const svc2 = new OrchestratorServiceV2({
      config,
      transport: new MockPeerTransport(),
      journalPath: jp,
    })

    expect(svc2.bus.state.internal.peers).toHaveLength(1)
    expect(svc2.bus.state.internal.peers[0].name).toBe('node-b')
    // Restored peer should be in 'initializing' state (not 'connected')
    expect(svc2.bus.state.internal.peers[0].connectionStatus).toBe('initializing')

    await svc2.stop()
  })

  it('does not double-append entries on replay — new actions append only once', async () => {
    const jp = freshJournalPath()

    // Session 1: add one route
    const svc1 = new OrchestratorServiceV2({
      config,
      transport: new MockPeerTransport(),
      journalPath: jp,
    })
    await svc1.bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })
    await svc1.stop()

    // Session 2: replay + add another route
    const svc2 = new OrchestratorServiceV2({
      config,
      transport: new MockPeerTransport(),
      journalPath: jp,
    })
    expect(svc2.bus.state.local.routes).toHaveLength(1)
    await svc2.bus.dispatch({ action: Actions.LocalRouteCreate, data: routeBeta })
    expect(svc2.bus.state.local.routes).toHaveLength(2)
    await svc2.stop()

    // Session 3: should have exactly 2 routes (not 3+ from double-appended alpha)
    const svc3 = new OrchestratorServiceV2({
      config,
      transport: new MockPeerTransport(),
      journalPath: jp,
    })
    expect(svc3.bus.state.local.routes).toHaveLength(2)
    await svc3.stop()
  })

  it('route create + delete in session 1 → empty state on restart', async () => {
    const jp = freshJournalPath()

    // Session 1: add then remove
    const svc1 = new OrchestratorServiceV2({
      config,
      transport: new MockPeerTransport(),
      journalPath: jp,
    })
    await svc1.bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })
    await svc1.bus.dispatch({ action: Actions.LocalRouteDelete, data: routeAlpha })
    expect(svc1.bus.state.local.routes).toHaveLength(0)
    await svc1.stop()

    // Session 2: replay should produce empty state
    const svc2 = new OrchestratorServiceV2({
      config,
      transport: new MockPeerTransport(),
      journalPath: jp,
    })
    expect(svc2.bus.state.local.routes).toHaveLength(0)
    await svc2.stop()
  })
})
