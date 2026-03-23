import { describe, it, expect } from 'vitest'
import { InMemoryActionLog, RoutingInformationBase } from '@catalyst/routing/v2'
import { Actions } from '@catalyst/routing/v2'
import type { ActionLog } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NODE_ID = 'node-a'

/**
 * Replay all journal entries into a fresh RIB and return the resulting state.
 * This mirrors what OrchestratorServiceV2 does in its constructor.
 */
function replayJournal(journal: ActionLog) {
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

describe('journal replay', () => {
  it('empty journal yields fresh state', () => {
    const journal = new InMemoryActionLog()

    const state = replayJournal(journal)

    expect(state.local.routes).toHaveLength(0)
    expect(state.internal.peers).toHaveLength(0)
    expect(state.internal.routes).toHaveLength(0)
  })

  it('replays a single LocalRouteCreate', () => {
    const journal = new InMemoryActionLog()
    journal.append(
      {
        action: Actions.LocalRouteCreate,
        data: { name: 'alpha', protocol: 'http' as const, endpoint: 'http://alpha:8080' },
      },
      NODE_ID
    )

    const state = replayJournal(journal)

    expect(state.local.routes).toHaveLength(1)
    expect(state.local.routes[0].name).toBe('alpha')
  })

  it('replays multiple actions in sequence — create and delete', () => {
    const journal = new InMemoryActionLog()
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
      { action: Actions.LocalRouteDelete, data: { name: 'alpha', protocol: 'http' as const } },
      NODE_ID
    )

    const state = replayJournal(journal)

    expect(state.local.routes).toHaveLength(1)
    expect(state.local.routes[0].name).toBe('beta')
  })

  it('replays peer lifecycle — create peer', () => {
    const journal = new InMemoryActionLog()
    const peerInfo = {
      name: 'node-b',
      endpoint: 'ws://node-b:4000',
      domains: ['example.local'],
    }
    journal.append({ action: Actions.LocalPeerCreate, data: peerInfo }, NODE_ID)

    const state = replayJournal(journal)

    expect(state.internal.peers).toHaveLength(1)
    expect(state.internal.peers[0].name).toBe('node-b')
    expect(state.internal.peers[0].connectionStatus).toBe('initializing')
  })

  it('replays connected status after InternalProtocolConnected', () => {
    const journal = new InMemoryActionLog()
    const peerInfo = {
      name: 'node-b',
      endpoint: 'ws://node-b:4000',
      domains: ['example.local'],
    }
    journal.append({ action: Actions.LocalPeerCreate, data: peerInfo }, NODE_ID)
    journal.append({ action: Actions.InternalProtocolConnected, data: { peerInfo } }, NODE_ID)

    const state = replayJournal(journal)

    const peer = state.internal.peers.find((p) => p.name === 'node-b')
    expect(peer?.connectionStatus).toBe('connected')
  })

  it('replays peer delete — peer absent after delete', () => {
    const journal = new InMemoryActionLog()
    const peerInfo = {
      name: 'node-b',
      endpoint: 'ws://node-b:4000',
      domains: ['example.local'],
    }
    journal.append({ action: Actions.LocalPeerCreate, data: peerInfo }, NODE_ID)
    journal.append({ action: Actions.LocalPeerDelete, data: { name: 'node-b' } }, NODE_ID)

    const state = replayJournal(journal)

    expect(state.internal.peers).toHaveLength(0)
  })

  it('skips duplicate (rejected) actions gracefully — second create for same route is a no-op', () => {
    const journal = new InMemoryActionLog()
    // Manually inject a duplicate — simulates a journal written with a bug
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
        data: { name: 'alpha', protocol: 'http' as const, endpoint: 'http://alpha:8080' },
      },
      NODE_ID
    )

    const state = replayJournal(journal)

    // Should have exactly one route, not two
    expect(state.local.routes).toHaveLength(1)
  })

  it('correctly replays a mixed sequence of peers and routes', () => {
    const journal = new InMemoryActionLog()
    const peerInfo = {
      name: 'node-b',
      endpoint: 'ws://node-b:4000',
      domains: ['example.local'],
    }

    journal.append({ action: Actions.LocalPeerCreate, data: peerInfo }, NODE_ID)
    journal.append(
      {
        action: Actions.LocalRouteCreate,
        data: { name: 'alpha', protocol: 'http' as const, endpoint: 'http://alpha:8080' },
      },
      NODE_ID
    )
    journal.append({ action: Actions.InternalProtocolConnected, data: { peerInfo } }, NODE_ID)
    journal.append(
      {
        action: Actions.LocalRouteCreate,
        data: { name: 'beta', protocol: 'http' as const, endpoint: 'http://beta:8080' },
      },
      NODE_ID
    )

    const state = replayJournal(journal)

    expect(state.local.routes).toHaveLength(2)
    expect(state.internal.peers).toHaveLength(1)
    expect(state.internal.peers[0].connectionStatus).toBe('connected')
  })
})
