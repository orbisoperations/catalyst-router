/**
 * Handler integration tests — mock the orchestrator client, test handler behavior.
 * These test the actual handler functions (not just utility helpers).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  LogEntry,
  LogClient,
  VerifyResult,
  FederatedListResult,
} from '../clients/orchestrator-client.js'

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function entry(seq: number, action: string, data: unknown, time?: string): LogEntry {
  return {
    seq,
    action: { action, data },
    nodeId: 'node-a',
    recorded_at: time || new Date(Date.now() - seq * 60_000).toISOString(),
  }
}

const ENTRIES: LogEntry[] = [
  entry(
    1,
    'local:peer:create',
    { name: 'peer-a', endpoint: 'ws://a:4000' },
    '2026-03-24T10:00:00Z'
  ),
  entry(
    2,
    'local:route:create',
    { name: 'svc-1', protocol: 'http:graphql', endpoint: 'http://svc:8080' },
    '2026-03-24T10:05:00Z'
  ),
  entry(3, 'system:tick', {}, '2026-03-24T10:05:10Z'),
  entry(
    4,
    'local:peer:create',
    { name: 'peer-b', endpoint: 'ws://b:4000' },
    '2026-03-24T11:00:00Z'
  ),
  entry(5, 'local:peer:delete', { name: 'peer-a' }, '2026-03-24T12:00:00Z'),
  entry(
    6,
    'local:route:create',
    { name: 'svc-2', protocol: 'http', endpoint: 'http://svc2:9090' },
    '2026-03-24T13:00:00Z'
  ),
]

function mockLogClient(entries: LogEntry[] = ENTRIES): LogClient {
  let store = [...entries]
  return {
    async listEntries(opts) {
      if (opts?.afterSeq) return store.filter((e) => e.seq > opts.afterSeq!)
      return [...store]
    },
    async getEntry(seq) {
      return store.find((e) => e.seq === seq) ?? null
    },
    async lastSeq() {
      return store.length > 0 ? Math.max(...store.map((e) => e.seq)) : 0
    },
    async count(opts) {
      if (opts?.afterSeq) return store.filter((e) => e.seq > opts.afterSeq!).length
      return store.length
    },
    async distinctActions() {
      return [...new Set(store.map((e) => e.action.action))].sort()
    },
    async verify(): Promise<VerifyResult> {
      return { consistent: true, journalSeq: store.length, mismatches: [] }
    },
    async federatedList(opts): Promise<FederatedListResult> {
      const local = store.slice(0, opts?.limit ?? 50).map((e) => ({ ...e, sourceNode: 'node-a' }))
      return { entries: local, unreachable: ['node-c'] }
    },
    async clear() {
      const count = store.length
      store = []
      return count
    },
  }
}

// Mock createOrchestratorClient
let mockClient: LogClient

vi.mock('../clients/orchestrator-client.js', () => ({
  createOrchestratorClient: vi.fn(async () => ({
    getLogClient: async () => ({ success: true, client: mockClient }),
    getNetworkClient: async () => ({ success: true, client: { listPeers: async () => [] } }),
    getDataChannelClient: async () => ({
      success: true,
      client: { listRoutes: async () => ({ local: [], internal: [] }) },
    }),
  })),
}))

// Import handlers AFTER mock is set up
const {
  listLogsHandler,
  showLogHandler,
  countLogsHandler,
  listActionsHandler,
  searchLogsHandler,
  blameHandler,
  computeDiffSummary,
  diffHandler,
  verifyHandler,
  clearLogsHandler,
  exportLogsHandler,
  federatedListHandler,
} = await import('./node-log-handlers.js')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockClient = mockLogClient()
})

describe('listLogsHandler', () => {
  it('returns all non-system entries by default', async () => {
    const result = await listLogsHandler({
      orchestratorUrl: 'ws://localhost:3000/rpc',
      logLevel: 'info' as const,
      limit: 50,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    const { entries } = result.data as { entries: LogEntry[] }
    expect(entries.every((e) => e.action.action !== 'system:tick')).toBe(true)
    expect(entries.length).toBe(5)
  })

  it('includes system entries when includeSystem is true', async () => {
    const result = await listLogsHandler({
      orchestratorUrl: 'ws://localhost:3000/rpc',
      logLevel: 'info' as const,
      limit: 50,
      includeSystem: true,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    const { entries } = result.data as { entries: LogEntry[] }
    expect(entries.some((e) => e.action.action === 'system:tick')).toBe(true)
    expect(entries.length).toBe(6)
  })

  it('filters by action', async () => {
    const result = await listLogsHandler({
      orchestratorUrl: 'ws://localhost:3000/rpc',
      logLevel: 'info' as const,
      limit: 50,
      action: 'local:peer:create',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    const { entries } = result.data as { entries: LogEntry[] }
    expect(entries.length).toBe(2)
    expect(entries.every((e) => e.action.action === 'local:peer:create')).toBe(true)
  })

  it('respects limit', async () => {
    const result = await listLogsHandler({
      orchestratorUrl: 'ws://localhost:3000/rpc',
      logLevel: 'info' as const,
      limit: 2,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    const { entries } = result.data as { entries: LogEntry[] }
    expect(entries.length).toBe(2)
  })

  it('respects afterSeq', async () => {
    const result = await listLogsHandler({
      orchestratorUrl: 'ws://localhost:3000/rpc',
      logLevel: 'info' as const,
      limit: 50,
      afterSeq: 4,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    const { entries } = result.data as { entries: LogEntry[] }
    expect(entries.every((e) => e.seq > 4)).toBe(true)
  })
})

describe('showLogHandler', () => {
  it('returns entry by seq', async () => {
    const result = await showLogHandler({ seq: 2, orchestratorUrl: 'ws://localhost:3000/rpc' })
    expect(result.success).toBe(true)
    if (!result.success) return
    const { entry } = result.data as { entry: LogEntry }
    expect(entry.seq).toBe(2)
    expect(entry.action.action).toBe('local:route:create')
  })

  it('returns error for nonexistent seq', async () => {
    const result = await showLogHandler({ seq: 999, orchestratorUrl: 'ws://localhost:3000/rpc' })
    expect(result.success).toBe(false)
  })
})

describe('countLogsHandler', () => {
  it('returns total count via server-side count()', async () => {
    const result = await countLogsHandler({ orchestratorUrl: 'ws://localhost:3000/rpc' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data!.count).toBe(6)
    expect(result.data!.lastSeq).toBe(6)
  })

  it('counts with afterSeq', async () => {
    const result = await countLogsHandler({
      afterSeq: 3,
      orchestratorUrl: 'ws://localhost:3000/rpc',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data!.count).toBe(3) // seq 4, 5, 6
  })

  it('counts with action filter (client-side)', async () => {
    const result = await countLogsHandler({
      action: 'local:peer:create',
      orchestratorUrl: 'ws://localhost:3000/rpc',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data!.count).toBe(2)
  })
})

describe('listActionsHandler', () => {
  it('returns distinct action types sorted', async () => {
    const result = await listActionsHandler({ orchestratorUrl: 'ws://localhost:3000/rpc' })
    expect(result.success).toBe(true)
    if (!result.success) return
    const names = result.data!.actions.map((a) => a.action)
    expect(names).toContain('local:peer:create')
    expect(names).toContain('local:route:create')
    expect(names).toContain('local:peer:delete')
    expect(names).toContain('system:tick')
    // Sorted alphabetically
    for (let i = 1; i < names.length; i++) {
      expect(names[i] >= names[i - 1]).toBe(true)
    }
  })
})

describe('searchLogsHandler', () => {
  it('finds entries matching query in data', async () => {
    const result = await searchLogsHandler({
      query: 'peer-a',
      orchestratorUrl: 'ws://localhost:3000/rpc',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data!.entries.length).toBeGreaterThanOrEqual(2) // create + delete
  })

  it('is case-insensitive', async () => {
    const result = await searchLogsHandler({
      query: 'PEER-A',
      orchestratorUrl: 'ws://localhost:3000/rpc',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data!.entries.length).toBeGreaterThanOrEqual(2)
  })

  it('returns empty for no match', async () => {
    const result = await searchLogsHandler({
      query: 'nonexistent-xyz',
      orchestratorUrl: 'ws://localhost:3000/rpc',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data!.entries.length).toBe(0)
  })

  it('respects limit', async () => {
    const result = await searchLogsHandler({
      query: 'local',
      limit: 1,
      orchestratorUrl: 'ws://localhost:3000/rpc',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data!.entries.length).toBe(1)
  })

  it('scopes with afterSeq', async () => {
    const result = await searchLogsHandler({
      query: 'peer',
      afterSeq: 4,
      orchestratorUrl: 'ws://localhost:3000/rpc',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data!.entries.every((e) => e.seq > 4)).toBe(true)
  })
})

describe('blameHandler', () => {
  it('finds all entries for an entity', async () => {
    const result = await blameHandler({
      name: 'peer-a',
      orchestratorUrl: 'ws://localhost:3000/rpc',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data!.entries.length).toBe(2) // create + delete
  })

  it('returns empty for unknown entity', async () => {
    const result = await blameHandler({
      name: 'nonexistent',
      orchestratorUrl: 'ws://localhost:3000/rpc',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data!.entries.length).toBe(0)
  })
})

describe('computeDiffSummary', () => {
  it('computes peers created/deleted and routes created', () => {
    const entries = ENTRIES.filter((e) => e.seq >= 1 && e.seq <= 6)
    const summary = computeDiffSummary(entries, 0, 6)

    expect(summary.peersCreated).toEqual(['peer-a', 'peer-b'])
    expect(summary.peersDeleted).toEqual(['peer-a'])
    expect(summary.routesCreated).toEqual(['svc-1', 'svc-2'])
    expect(summary.routesDeleted).toEqual([])
    expect(summary.totalEntries).toBe(6)
    expect(summary.systemEntries).toBe(1) // system:tick
    expect(summary.operatorEntries).toBe(5)
  })

  it('counts operator actions correctly', () => {
    const entries = ENTRIES.filter((e) => e.seq >= 4 && e.seq <= 6)
    const summary = computeDiffSummary(entries, 3, 6)

    expect(summary.operatorActions.length).toBe(3)
    expect(summary.operatorActions[0].action).toBe('local:peer:create')
    expect(summary.operatorActions[0].entity).toBe('peer-b')
  })
})

describe('diffHandler', () => {
  it('returns diff for valid range', async () => {
    const result = await diffHandler({
      fromSeq: 0,
      toSeq: 6,
      orchestratorUrl: 'ws://localhost:3000/rpc',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.peersCreated).toContain('peer-a')
    expect(result.data.peersCreated).toContain('peer-b')
  })

  it('returns error for empty range', async () => {
    const result = await diffHandler({
      fromSeq: 100,
      toSeq: 200,
      orchestratorUrl: 'ws://localhost:3000/rpc',
    })
    expect(result.success).toBe(false)
  })
})

describe('verifyHandler', () => {
  it('returns verify result', async () => {
    const result = await verifyHandler({ orchestratorUrl: 'ws://localhost:3000/rpc' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data!.consistent).toBe(true)
  })
})

describe('clearLogsHandler', () => {
  it('clears journal and returns count', async () => {
    const result = await clearLogsHandler({ orchestratorUrl: 'ws://localhost:3000/rpc' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data!.pruned).toBe(6)
  })
})

describe('exportLogsHandler', () => {
  it('rejects if file already exists', async () => {
    // /dev/null always exists
    const result = await exportLogsHandler({
      outputPath: '/dev/null',
      orchestratorUrl: 'ws://localhost:3000/rpc',
      logLevel: 'info' as const,
      limit: 50,
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain('already exists')
  })

  it('rejects if directory does not exist', async () => {
    const result = await exportLogsHandler({
      outputPath: '/nonexistent-dir-abc123/out.json',
      orchestratorUrl: 'ws://localhost:3000/rpc',
      logLevel: 'info' as const,
      limit: 50,
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain('does not exist')
  })

  it('writes to valid path', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = await mkdtemp(join(tmpdir(), 'catalyst-test-'))
    const outPath = join(dir, 'export.json')

    try {
      const result = await exportLogsHandler({
        outputPath: outPath,
        orchestratorUrl: 'ws://localhost:3000/rpc',
        logLevel: 'info' as const,
        limit: 50,
      })
      expect(result.success).toBe(true)
      if (!result.success) return

      const content = JSON.parse(await readFile(outPath, 'utf-8'))
      expect(content.entry_count).toBe(5) // 6 minus system:tick
      expect(content.entries).toHaveLength(5)
      expect(content.exported_at).toBeDefined()
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})

describe('federatedListHandler', () => {
  it('returns entries with source node and unreachable list', async () => {
    const result = await federatedListHandler({ orchestratorUrl: 'ws://localhost:3000/rpc' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.entries.length).toBeGreaterThan(0)
    expect(result.data.entries[0]).toHaveProperty('sourceNode')
    expect(result.data.unreachable).toContain('node-c')
  })

  it('filters by action', async () => {
    const result = await federatedListHandler({
      action: 'local:peer:create',
      orchestratorUrl: 'ws://localhost:3000/rpc',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.entries.every((e) => e.action.action === 'local:peer:create')).toBe(true)
  })
})
