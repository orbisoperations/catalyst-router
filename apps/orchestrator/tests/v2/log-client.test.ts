import { describe, it, expect } from 'vitest'
import { InMemoryActionLog, Actions } from '@catalyst/routing/v2'
import { createLogClient, scrubEntry } from '../../src/v2/rpc.js'
import type { TokenValidator } from '../../src/v2/rpc.js'
import type { ActionLogEntry } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const allowAllValidator: TokenValidator = {
  async validateToken() {
    return { valid: true }
  },
}

const rejectAllValidator: TokenValidator = {
  async validateToken() {
    return { valid: false, error: 'Unauthorized' }
  },
}

function populatedLog() {
  const log = new InMemoryActionLog()
  log.append(
    {
      action: Actions.LocalPeerCreate,
      data: {
        name: 'peer-a',
        endpoint: 'ws://a:4000',
        domains: ['d1'],
        peerToken: 'secret-tok-123',
      },
    },
    'node-a'
  )
  log.append(
    {
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-1', protocol: 'http:graphql' as const, endpoint: 'http://svc:8080' },
    },
    'node-a'
  )
  log.append(
    {
      action: Actions.LocalPeerCreate,
      data: { name: 'peer-b', endpoint: 'ws://b:4000', domains: [], peerToken: 'secret-tok-456' },
    },
    'node-a'
  )
  return log
}

// ---------------------------------------------------------------------------
// createLogClient
// ---------------------------------------------------------------------------

describe('createLogClient', () => {
  it('rejects when token validation fails', async () => {
    const log = new InMemoryActionLog()
    const result = await createLogClient(log, 'bad-token', rejectAllValidator)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Unauthorized')
    }
  })

  it('returns a client when token is valid', async () => {
    const log = new InMemoryActionLog()
    const result = await createLogClient(log, 'good-token', allowAllValidator)
    expect(result.success).toBe(true)
  })

  it('listEntries returns all entries', async () => {
    const log = populatedLog()
    const result = await createLogClient(log, 'tok', allowAllValidator)
    if (!result.success) throw new Error('unexpected')

    const entries = await result.client.listEntries()
    expect(entries).toHaveLength(3)
    expect(entries[0].seq).toBe(1)
    expect(entries[2].seq).toBe(3)
  })

  it('listEntries respects afterSeq', async () => {
    const log = populatedLog()
    const result = await createLogClient(log, 'tok', allowAllValidator)
    if (!result.success) throw new Error('unexpected')

    const entries = await result.client.listEntries({ afterSeq: 2 })
    expect(entries).toHaveLength(1)
    expect(entries[0].seq).toBe(3)
  })

  it('lastSeq returns the last sequence number', async () => {
    const log = populatedLog()
    const result = await createLogClient(log, 'tok', allowAllValidator)
    if (!result.success) throw new Error('unexpected')

    const seq = await result.client.lastSeq()
    expect(seq).toBe(3)
  })

  it('scrubs sensitive fields from returned entries', async () => {
    const log = populatedLog()
    const result = await createLogClient(log, 'tok', allowAllValidator)
    if (!result.success) throw new Error('unexpected')

    const entries = await result.client.listEntries()
    const peerEntry = entries[0]
    const data = peerEntry.action.data as Record<string, unknown>
    expect(data).not.toHaveProperty('peerToken')
    expect(data).toHaveProperty('name', 'peer-a')
  })

  it('getEntry returns entry by seq', async () => {
    const log = populatedLog()
    const result = await createLogClient(log, 'tok', allowAllValidator)
    if (!result.success) throw new Error('unexpected')

    const entry = await result.client.getEntry(2)
    expect(entry).not.toBeNull()
    expect(entry!.seq).toBe(2)
    expect(entry!.action.action).toBe(Actions.LocalRouteCreate)
  })

  it('getEntry returns null for nonexistent seq', async () => {
    const log = populatedLog()
    const result = await createLogClient(log, 'tok', allowAllValidator)
    if (!result.success) throw new Error('unexpected')

    const entry = await result.client.getEntry(999)
    expect(entry).toBeNull()
  })

  it('getEntry scrubs sensitive fields', async () => {
    const log = populatedLog()
    const result = await createLogClient(log, 'tok', allowAllValidator)
    if (!result.success) throw new Error('unexpected')

    const entry = await result.client.getEntry(1)
    expect(entry).not.toBeNull()
    const data = entry!.action.data as Record<string, unknown>
    expect(data).not.toHaveProperty('peerToken')
    expect(data).toHaveProperty('name', 'peer-a')
  })
})

// ---------------------------------------------------------------------------
// scrubEntry
// ---------------------------------------------------------------------------

describe('scrubEntry', () => {
  const baseEntry: Omit<ActionLogEntry, 'action'> = {
    seq: 1,
    nodeId: 'node-a',
    recorded_at: '2026-03-22T00:00:00Z',
  }

  it('strips peerToken from peer create actions', () => {
    const entry: ActionLogEntry = {
      ...baseEntry,
      action: {
        action: Actions.LocalPeerCreate,
        data: { name: 'p', endpoint: 'ws://x', domains: [], peerToken: 'secret' },
      },
    }
    const scrubbed = scrubEntry(entry)
    const data = scrubbed.action.data as Record<string, unknown>
    expect(data).not.toHaveProperty('peerToken')
    expect(data).toHaveProperty('name', 'p')
  })

  it('strips fields matching sensitive patterns', () => {
    const entry: ActionLogEntry = {
      ...baseEntry,
      action: {
        action: Actions.LocalPeerCreate,
        data: {
          name: 'p',
          endpoint: 'ws://x',
          domains: [],
          peerToken: 'tok1',
          secretKey: 'sk',
          password: 'pw',
          apiKey: 'ak',
          credential: 'cred',
        },
      },
    }
    const scrubbed = scrubEntry(entry)
    const data = scrubbed.action.data as Record<string, unknown>
    expect(data).not.toHaveProperty('peerToken')
    expect(data).not.toHaveProperty('secretKey')
    expect(data).not.toHaveProperty('password')
    expect(data).not.toHaveProperty('apiKey')
    expect(data).not.toHaveProperty('credential')
    expect(data).toHaveProperty('name', 'p')
    expect(data).toHaveProperty('endpoint', 'ws://x')
  })

  it('recursively strips sensitive fields from nested objects', () => {
    const entry: ActionLogEntry = {
      ...baseEntry,
      action: {
        action: Actions.InternalProtocolConnected,
        data: {
          peerInfo: {
            name: 'peer-b',
            endpoint: 'ws://b:4000',
            peerToken: 'nested-secret',
            config: {
              apiKey: 'deeply-nested-key',
              timeout: 30,
            },
          },
          holdTime: 90,
        },
      },
    }
    const scrubbed = scrubEntry(entry)
    const data = scrubbed.action.data as Record<string, unknown>
    const peerInfo = data.peerInfo as Record<string, unknown>
    expect(peerInfo).not.toHaveProperty('peerToken')
    expect(peerInfo).toHaveProperty('name', 'peer-b')
    expect(peerInfo).toHaveProperty('endpoint', 'ws://b:4000')
    const config = peerInfo.config as Record<string, unknown>
    expect(config).not.toHaveProperty('apiKey')
    expect(config).toHaveProperty('timeout', 30)
    expect(data).toHaveProperty('holdTime', 90)
  })

  it('handles arrays with nested objects containing sensitive fields', () => {
    const entry: ActionLogEntry = {
      ...baseEntry,
      action: {
        action: Actions.InternalProtocolUpdate,
        data: {
          peers: [
            { name: 'a', peerToken: 'secret-a' },
            { name: 'b', peerToken: 'secret-b' },
          ],
        },
      },
    }
    const scrubbed = scrubEntry(entry)
    const data = scrubbed.action.data as Record<string, unknown>
    const peers = data.peers as Record<string, unknown>[]
    expect(peers[0]).not.toHaveProperty('peerToken')
    expect(peers[0]).toHaveProperty('name', 'a')
    expect(peers[1]).not.toHaveProperty('peerToken')
    expect(peers[1]).toHaveProperty('name', 'b')
  })

  it('passes through entries with no sensitive fields', () => {
    const entry: ActionLogEntry = {
      ...baseEntry,
      action: {
        action: Actions.LocalRouteCreate,
        data: { name: 'svc', protocol: 'http:graphql' as const, endpoint: 'http://x' },
      },
    }
    const scrubbed = scrubEntry(entry)
    expect(scrubbed.action.data).toEqual(entry.action.data)
  })

  it('does not mutate the original entry', () => {
    const original = {
      name: 'p',
      endpoint: 'ws://x',
      domains: [],
      peerToken: 'secret',
    }
    const entry: ActionLogEntry = {
      ...baseEntry,
      action: { action: Actions.LocalPeerCreate, data: { ...original } },
    }
    scrubEntry(entry)
    expect((entry.action.data as Record<string, unknown>).peerToken).toBe('secret')
  })
})
