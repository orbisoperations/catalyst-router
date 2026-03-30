import { describe, it, expect, beforeEach } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const config: OrchestratorConfig = {
  node: {
    name: 'node-a',
    endpoint: 'ws://node-a:4000',
    domains: ['token.local'],
  },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrchestratorBus — peerToken validation on LocalPeerCreate', () => {
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(() => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config, transport })
  })

  it('rejects LocalPeerCreate without peerToken', async () => {
    const peerInfo: PeerInfo = {
      name: 'node-b',
      endpoint: 'ws://node-b:4000',
      domains: ['token.local'],
    }

    const result = await bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: peerInfo,
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('peerToken')
    }

    // Peer must NOT be added to state
    expect(bus.state.internal.peers).toHaveLength(0)
  })

  it('rejects LocalPeerCreate with empty string peerToken', async () => {
    const peerInfo: PeerInfo = {
      name: 'node-b',
      endpoint: 'ws://node-b:4000',
      domains: ['token.local'],
      peerToken: '',
    }

    const result = await bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: peerInfo,
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('peerToken')
    }

    expect(bus.state.internal.peers).toHaveLength(0)
  })

  it('accepts LocalPeerCreate with valid peerToken', async () => {
    const peerInfo: PeerInfo = {
      name: 'node-b',
      endpoint: 'ws://node-b:4000',
      domains: ['token.local'],
      peerToken: 'some-token',
    }

    const result = await bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: peerInfo,
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.state.internal.peers).toHaveLength(1)
      expect(result.state.internal.peers[0].name).toBe('node-b')
    }
  })
})
