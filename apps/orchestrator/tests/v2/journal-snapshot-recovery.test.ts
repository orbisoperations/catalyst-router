import { describe, it, expect } from 'vitest'
import { InMemoryActionLog, RoutingInformationBase, Actions } from '@catalyst/routing/v2'
import type { ActionLog } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NODE_ID = 'node-a'

/**
 * Snapshot-aware replay — mirrors OrchestratorServiceV2 constructor recovery logic.
 */
function recoverFromJournal(journal: ActionLog) {
  const rib = new RoutingInformationBase({ nodeId: NODE_ID })
  const snapshot = journal.getSnapshot()
  let replayAfterSeq = 0

  if (snapshot) {
    Object.assign(rib.state, snapshot.state)
    replayAfterSeq = snapshot.atSeq
  }

  for (const entry of journal.replay(replayAfterSeq)) {
    const plan = rib.plan(entry.action, rib.state)
    if (rib.stateChanged(plan)) {
      rib.commit(plan, entry.action)
    }
  }
  return rib.state
}

/**
 * Full replay from beginning — no snapshot.
 */
function fullReplay(journal: ActionLog) {
  const rib = new RoutingInformationBase({ nodeId: NODE_ID })
  for (const entry of journal.replay()) {
    const plan = rib.plan(entry.action, rib.state)
    if (rib.stateChanged(plan)) {
      rib.commit(plan, entry.action)
    }
  }
  return rib.state
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('snapshot-based recovery', () => {
  it('snapshot + tail replay produces same state as full replay', () => {
    const journal = new InMemoryActionLog()

    // Build up some state
    journal.append(
      {
        action: Actions.LocalRouteCreate,
        data: { name: 'alpha', protocol: 'http' as const, endpoint: 'http://alpha:8080' },
      },
      NODE_ID
    )
    journal.append(
      {
        action: Actions.LocalRouteCreate,
        data: { name: 'beta', protocol: 'http' as const, endpoint: 'http://beta:8080' },
      },
      NODE_ID
    )
    journal.append(
      {
        action: Actions.LocalPeerCreate,
        data: { name: 'node-b', endpoint: 'ws://node-b:4000', domains: ['example.local'] },
      },
      NODE_ID
    )

    // Take snapshot at seq 3, preserving full state
    const fullState = fullReplay(journal)
    journal.snapshot(3, fullState)

    // Add tail entries after snapshot
    journal.append(
      {
        action: Actions.LocalRouteCreate,
        data: { name: 'gamma', protocol: 'http' as const, endpoint: 'http://gamma:8080' },
      },
      NODE_ID
    )
    journal.append(
      { action: Actions.LocalRouteDelete, data: { name: 'alpha', protocol: 'http' as const } },
      NODE_ID
    )

    // Recover via snapshot + tail
    const recoveredState = recoverFromJournal(journal)

    // Full replay (using all entries) should give the same result
    const expectedState = fullReplay(journal)

    expect(recoveredState.local.routes).toEqual(expectedState.local.routes)
    expect(recoveredState.internal.peers).toEqual(expectedState.internal.peers)
  })

  it('recovery works after compaction (prune + snapshot)', () => {
    const journal = new InMemoryActionLog()

    // Build up state
    for (let i = 0; i < 20; i++) {
      journal.append(
        {
          action: Actions.LocalRouteCreate,
          data: {
            name: `route-${i}`,
            protocol: 'http' as const,
            endpoint: `http://route-${i}:8080`,
          },
        },
        NODE_ID
      )
    }

    // Snapshot at seq 20
    const stateBeforeCompaction = fullReplay(journal)
    journal.snapshot(20, stateBeforeCompaction)

    // Prune old entries, keeping tail of 5
    journal.prune(16) // keeps seqs 16-20

    // Add more entries after compaction
    journal.append(
      {
        action: Actions.LocalRouteCreate,
        data: { name: 'post-compact', protocol: 'http' as const, endpoint: 'http://post:8080' },
      },
      NODE_ID
    )

    // Recovery should work from snapshot + tail
    const recovered = recoverFromJournal(journal)

    expect(recovered.local.routes).toHaveLength(21)
    expect(recovered.local.routes.map((r) => r.name)).toContain('post-compact')
    expect(recovered.local.routes.map((r) => r.name)).toContain('route-0')
  })

  it('recovery from snapshot alone (no tail entries)', () => {
    const journal = new InMemoryActionLog()

    journal.append(
      {
        action: Actions.LocalRouteCreate,
        data: { name: 'alpha', protocol: 'http' as const, endpoint: 'http://alpha:8080' },
      },
      NODE_ID
    )

    const state = fullReplay(journal)
    journal.snapshot(1, state)
    journal.prune(2) // prune everything

    const recovered = recoverFromJournal(journal)
    expect(recovered.local.routes).toHaveLength(1)
    expect(recovered.local.routes[0].name).toBe('alpha')
  })

  it('recovery without snapshot replays from beginning', () => {
    const journal = new InMemoryActionLog()

    journal.append(
      {
        action: Actions.LocalRouteCreate,
        data: { name: 'alpha', protocol: 'http' as const, endpoint: 'http://alpha:8080' },
      },
      NODE_ID
    )

    // No snapshot — full replay from beginning
    const recovered = recoverFromJournal(journal)
    expect(recovered.local.routes).toHaveLength(1)
    expect(recovered.local.routes[0].name).toBe('alpha')
  })
})
