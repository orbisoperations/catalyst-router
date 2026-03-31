import { describe, expect, it } from 'vitest'
import type { LogEntry } from '../clients/orchestrator-client.js'
import {
  isSystemAction,
  extractEntityNames,
  filterByTimeRange,
  SYSTEM_ACTION_PREFIXES,
  DEFAULT_LIMIT,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
} from './node-log-handlers.js'
import { parseTimeExpr, formatDuration } from '../output.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function entry(seq: number, action: string, data: unknown, time?: string): LogEntry {
  return {
    seq,
    action: { action, data },
    nodeId: 'node-a',
    recorded_at: time || new Date(Date.now() - seq * 60_000).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// isSystemAction
// ---------------------------------------------------------------------------

describe('isSystemAction', () => {
  it('identifies system:tick', () => {
    expect(isSystemAction('system:tick')).toBe(true)
  })

  it('identifies any system: prefix', () => {
    expect(isSystemAction('system:anything')).toBe(true)
  })

  it('identifies internal:protocol:keepalive', () => {
    expect(isSystemAction('internal:protocol:keepalive')).toBe(true)
  })

  it('does NOT flag local:peer:create', () => {
    expect(isSystemAction('local:peer:create')).toBe(false)
  })

  it('does NOT flag local:route:create', () => {
    expect(isSystemAction('local:route:create')).toBe(false)
  })

  it('does NOT flag internal:protocol:open', () => {
    expect(isSystemAction('internal:protocol:open')).toBe(false)
  })

  it('does NOT flag internal:protocol:connected', () => {
    expect(isSystemAction('internal:protocol:connected')).toBe(false)
  })

  it('does NOT flag internal:protocol:update', () => {
    expect(isSystemAction('internal:protocol:update')).toBe(false)
  })

  it('does NOT flag internal:protocol:close', () => {
    expect(isSystemAction('internal:protocol:close')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// extractEntityNames
// ---------------------------------------------------------------------------

describe('extractEntityNames', () => {
  it('extracts name from local:peer:create', () => {
    const e = entry(1, 'local:peer:create', { name: 'peer-a', endpoint: 'ws://a:4000' })
    expect(extractEntityNames(e)).toEqual(['peer-a'])
  })

  it('extracts name from local:route:create', () => {
    const e = entry(1, 'local:route:create', { name: 'svc-1', protocol: 'http:graphql' })
    expect(extractEntityNames(e)).toEqual(['svc-1'])
  })

  it('extracts name from local:peer:delete', () => {
    const e = entry(1, 'local:peer:delete', { name: 'peer-a' })
    expect(extractEntityNames(e)).toEqual(['peer-a'])
  })

  it('extracts peerInfo.name from internal:protocol:open', () => {
    const e = entry(1, 'internal:protocol:open', { peerInfo: { name: 'peer-b' }, holdTime: 90 })
    expect(extractEntityNames(e)).toEqual(['peer-b'])
  })

  it('extracts peerInfo.name from internal:protocol:close', () => {
    const e = entry(1, 'internal:protocol:close', { peerInfo: { name: 'peer-c' }, code: 0 })
    expect(extractEntityNames(e)).toEqual(['peer-c'])
  })

  it('extracts peerInfo.name from internal:protocol:connected', () => {
    const e = entry(1, 'internal:protocol:connected', { peerInfo: { name: 'peer-d' } })
    expect(extractEntityNames(e)).toEqual(['peer-d'])
  })

  it('extracts peerInfo.name from internal:protocol:keepalive', () => {
    const e = entry(1, 'internal:protocol:keepalive', { peerInfo: { name: 'peer-e' } })
    expect(extractEntityNames(e)).toEqual(['peer-e'])
  })

  it('extracts peer and route names from internal:protocol:update', () => {
    const e = entry(1, 'internal:protocol:update', {
      peerInfo: { name: 'peer-f' },
      update: {
        updates: [
          { action: 'add', route: { name: 'svc-x' }, nodePath: [], originNode: 'n1' },
          { action: 'remove', route: { name: 'svc-y' }, nodePath: [], originNode: 'n2' },
        ],
      },
    })
    const names = extractEntityNames(e)
    expect(names).toContain('peer-f')
    expect(names).toContain('svc-x')
    expect(names).toContain('svc-y')
  })

  it('deduplicates entity names', () => {
    const e = entry(1, 'internal:protocol:update', {
      peerInfo: { name: 'peer-a' },
      update: {
        updates: [{ action: 'add', route: { name: 'peer-a' }, nodePath: [], originNode: 'n1' }],
      },
    })
    const names = extractEntityNames(e)
    expect(names).toEqual(['peer-a'])
  })

  it('returns empty for system:tick', () => {
    const e = entry(1, 'system:tick', { now: Date.now() })
    expect(extractEntityNames(e)).toEqual([])
  })

  it('returns empty for null data', () => {
    const e = entry(1, 'local:peer:create', null)
    expect(extractEntityNames(e)).toEqual([])
  })

  it('returns empty for undefined data', () => {
    const e = entry(1, 'local:peer:create', undefined)
    expect(extractEntityNames(e)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// filterByTimeRange
// ---------------------------------------------------------------------------

describe('filterByTimeRange', () => {
  const entries: LogEntry[] = [
    entry(1, 'local:peer:create', { name: 'a' }, '2026-03-24T10:00:00.000Z'),
    entry(2, 'local:peer:create', { name: 'b' }, '2026-03-24T12:00:00.000Z'),
    entry(3, 'local:peer:create', { name: 'c' }, '2026-03-24T14:00:00.000Z'),
  ]

  it('filters entries after since', () => {
    const result = filterByTimeRange(entries, '2026-03-24T11:00:00.000Z')
    expect(result).toHaveLength(2)
    expect(result[0].seq).toBe(2)
  })

  it('filters entries before until', () => {
    const result = filterByTimeRange(entries, undefined, '2026-03-24T13:00:00.000Z')
    expect(result).toHaveLength(2)
    expect(result[0].seq).toBe(1)
    expect(result[1].seq).toBe(2)
  })

  it('filters with both since and until', () => {
    const result = filterByTimeRange(
      entries,
      '2026-03-24T11:00:00.000Z',
      '2026-03-24T13:00:00.000Z'
    )
    expect(result).toHaveLength(1)
    expect(result[0].seq).toBe(2)
  })

  it('returns all when no bounds', () => {
    const result = filterByTimeRange(entries)
    expect(result).toHaveLength(3)
  })

  it('returns empty when range excludes all', () => {
    const result = filterByTimeRange(entries, '2026-03-25T00:00:00.000Z')
    expect(result).toHaveLength(0)
  })

  it('handles timestamps without Z suffix', () => {
    const noZ: LogEntry[] = [
      entry(1, 'local:peer:create', { name: 'a' }, '2026-03-24T10:00:00.000'),
    ]
    // Since filter uses epoch ms comparison, both formats should parse correctly
    const result = filterByTimeRange(noZ, '2026-03-24T09:00:00.000Z')
    expect(result).toHaveLength(1)
  })

  it('keeps entries with unparseable timestamps', () => {
    const bad: LogEntry[] = [entry(1, 'local:peer:create', { name: 'a' }, 'not-a-date')]
    const result = filterByTimeRange(bad, '2026-03-24T00:00:00.000Z')
    expect(result).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// parseTimeExpr
// ---------------------------------------------------------------------------

describe('parseTimeExpr', () => {
  it('parses "now" as current time', () => {
    const before = Date.now()
    const result = parseTimeExpr('now')
    expect(result).not.toBeNull()
    expect(result!.getTime()).toBeGreaterThanOrEqual(before)
    expect(result!.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('parses "2h" as 2 hours ago', () => {
    const result = parseTimeExpr('2h')
    expect(result).not.toBeNull()
    const diff = Date.now() - result!.getTime()
    expect(diff).toBeGreaterThan(7_100_000) // ~2h in ms with tolerance
    expect(diff).toBeLessThan(7_300_000)
  })

  it('parses "30m" as 30 minutes ago', () => {
    const result = parseTimeExpr('30m')
    expect(result).not.toBeNull()
    const diff = Date.now() - result!.getTime()
    expect(diff).toBeGreaterThan(1_790_000)
    expect(diff).toBeLessThan(1_810_000)
  })

  it('parses compound "6h30m"', () => {
    const result = parseTimeExpr('6h30m')
    expect(result).not.toBeNull()
    const diff = Date.now() - result!.getTime()
    const expected = 6 * 3_600_000 + 30 * 60_000
    expect(diff).toBeGreaterThan(expected - 5000)
    expect(diff).toBeLessThan(expected + 5000)
  })

  it('parses "1d" as 1 day ago', () => {
    const result = parseTimeExpr('1d')
    expect(result).not.toBeNull()
    const diff = Date.now() - result!.getTime()
    expect(diff).toBeGreaterThan(86_000_000)
    expect(diff).toBeLessThan(86_500_000)
  })

  it('parses ISO 8601 timestamp', () => {
    const result = parseTimeExpr('2026-03-24T00:00:00.000Z')
    expect(result).not.toBeNull()
    expect(result!.toISOString()).toBe('2026-03-24T00:00:00.000Z')
  })

  it('returns null for invalid input', () => {
    expect(parseTimeExpr('garbage')).toBeNull()
    expect(parseTimeExpr('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('formats seconds', () => {
    expect(formatDuration(30_000)).toBe('30s')
  })

  it('formats minutes', () => {
    expect(formatDuration(300_000)).toBe('5m')
  })

  it('formats hours and minutes', () => {
    expect(formatDuration(3_900_000)).toBe('1h 5m')
  })

  it('formats days and hours', () => {
    expect(formatDuration(90_000_000)).toBe('1d 1h')
  })

  it('formats exact hours', () => {
    expect(formatDuration(7_200_000)).toBe('2h')
  })

  it('formats exact days', () => {
    expect(formatDuration(172_800_000)).toBe('2d')
  })
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Constants', () => {
  it('DEFAULT_LIMIT is 50', () => {
    expect(DEFAULT_LIMIT).toBe(50)
  })

  it('DEFAULT_POLL_INTERVAL_MS is 2000', () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(2000)
  })

  it('MIN_POLL_INTERVAL_MS is 500', () => {
    expect(MIN_POLL_INTERVAL_MS).toBe(500)
  })

  it('SYSTEM_ACTION_PREFIXES includes system: and keepalive', () => {
    expect(SYSTEM_ACTION_PREFIXES).toContain('system:')
    expect(SYSTEM_ACTION_PREFIXES).toContain('internal:protocol:keepalive')
  })
})
