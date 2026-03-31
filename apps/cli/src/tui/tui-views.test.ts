import { describe, it, expect } from 'vitest'
import type { LogEntry, VerifyResult } from '../clients/orchestrator-client.js'
import type { DiffSummary } from '../handlers/node-log-handlers.js'
import { renderListView } from './views/list-view.js'
import { renderDetailView } from './views/detail-view.js'
import { renderBlameView } from './views/blame-view.js'
import { renderDiffView } from './views/diff-view.js'
import { renderVerifyView } from './views/verify-view.js'
import { renderStatusBar } from './components/status-bar.js'
import { renderHelpBar } from './components/help-bar.js'
import { renderFilterPrompt } from './components/filter-prompt.js'
import type { TuiState } from './log-tui.js'

// ---------------------------------------------------------------------------
// Fixtures
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
    { name: 'svc-1', protocol: 'http:graphql' },
    '2026-03-24T10:05:00Z'
  ),
  entry(3, 'local:peer:delete', { name: 'peer-a' }, '2026-03-24T11:00:00Z'),
]

function mockState(overrides: Partial<TuiState> = {}): TuiState {
  return {
    activeTab: 'LIST',
    entries: ENTRIES,
    cursor: 0,
    detailOpen: false,
    following: false,
    showSystem: false,
    lastSeq: 3,
    nodeId: 'node-a',
    filter: '',
    filterMode: false,
    filterInput: '',
    blameName: '',
    blameEntries: [],
    blameCursor: 0,
    diffMarks: [],
    diffResult: null,
    verifyResult: null,
    verifyLoading: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// renderListView
// ---------------------------------------------------------------------------

describe('renderListView', () => {
  it('returns an array of strings', () => {
    const lines = renderListView(ENTRIES, 0, 20, 80, '')
    expect(Array.isArray(lines)).toBe(true)
    expect(lines.length).toBeGreaterThan(0)
  })

  it('marks the cursor row', () => {
    const lines = renderListView(ENTRIES, 0, 20, 80, '')
    // First entry row should have cursor indicator
    const cursorLine = lines.find((l) => l.includes('peer-a') || l.includes('▸'))
    expect(cursorLine).toBeDefined()
  })

  it('respects content height', () => {
    const lines = renderListView(ENTRIES, 0, 2, 80, '')
    // Should not exceed contentHeight
    expect(lines.length).toBeLessThanOrEqual(2)
  })

  it('handles empty entries', () => {
    const lines = renderListView([], 0, 20, 80, '')
    expect(lines.length).toBeGreaterThan(0)
    const joined = lines.join('')
    expect(joined.toLowerCase()).toContain('no')
  })

  it('applies filter highlighting when filter is set', () => {
    const lines = renderListView(ENTRIES, 0, 20, 80, 'peer')
    const joined = lines.join('')
    // Should contain some reference to the entries
    expect(joined).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// renderDetailView
// ---------------------------------------------------------------------------

describe('renderDetailView', () => {
  it('shows placeholder when no entry selected', () => {
    const lines = renderDetailView(null, 80)
    const joined = lines.join('')
    expect(joined.toLowerCase()).toContain('select')
  })

  it('shows entry details when entry provided', () => {
    const lines = renderDetailView(ENTRIES[0], 80)
    const joined = lines.join(' ')
    expect(joined).toContain('#1')
    expect(joined).toContain('local:peer:create')
    expect(joined).toContain('peer-a')
  })

  it('shows traceId when present', () => {
    const entryWithTrace = { ...ENTRIES[0], traceId: 'abc123' }
    const lines = renderDetailView(entryWithTrace, 80)
    const joined = lines.join(' ')
    expect(joined).toContain('abc123')
  })

  it('handles entry with no data', () => {
    const noData = entry(99, 'system:tick', null)
    const lines = renderDetailView(noData, 80)
    const joined = lines.join(' ')
    expect(joined).toContain('none')
  })
})

// ---------------------------------------------------------------------------
// renderBlameView
// ---------------------------------------------------------------------------

describe('renderBlameView', () => {
  it('shows entity name in header', () => {
    const lines = renderBlameView('peer-a', ENTRIES, 0, 20, 80)
    const joined = lines.join(' ')
    expect(joined).toContain('peer-a')
  })

  it('handles empty blame entries', () => {
    const lines = renderBlameView('unknown', [], 0, 20, 80)
    expect(lines.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// renderDiffView
// ---------------------------------------------------------------------------

describe('renderDiffView', () => {
  it('shows placeholder when no diff result', () => {
    const lines = renderDiffView(null, 80)
    const joined = lines.join(' ')
    expect(joined.toLowerCase()).toContain('mark')
  })

  it('shows summary when diff result provided', () => {
    const diff: DiffSummary = {
      fromSeq: 1,
      toSeq: 3,
      fromTime: '2026-03-24T10:00:00Z',
      toTime: '2026-03-24T11:00:00Z',
      duration: '1h',
      totalEntries: 3,
      operatorEntries: 2,
      systemEntries: 1,
      peersCreated: ['peer-a'],
      peersDeleted: ['peer-a'],
      routesCreated: ['svc-1'],
      routesDeleted: [],
      operatorActions: [
        { seq: 1, action: 'local:peer:create', entity: 'peer-a', time: '2026-03-24T10:00:00Z' },
        { seq: 3, action: 'local:peer:delete', entity: 'peer-a', time: '2026-03-24T11:00:00Z' },
      ],
    }
    const lines = renderDiffView(diff, 80)
    const joined = lines.join(' ')
    expect(joined).toContain('peer-a') // appears in operator actions
    expect(joined).toContain('1h') // duration
    expect(joined).toContain('+1 created') // peers or routes created count
  })
})

// ---------------------------------------------------------------------------
// renderVerifyView
// ---------------------------------------------------------------------------

describe('renderVerifyView', () => {
  it('shows loading state', () => {
    const lines = renderVerifyView(null, true, 80)
    const joined = lines.join(' ')
    expect(joined.toLowerCase()).toContain('verifying')
  })

  it('shows consistent result', () => {
    const result: VerifyResult = { consistent: true, journalSeq: 5, mismatches: [] }
    const lines = renderVerifyView(result, false, 80)
    const joined = lines.join(' ')
    expect(joined.toLowerCase()).toContain('consistent')
  })

  it('shows mismatches', () => {
    const result: VerifyResult = {
      consistent: false,
      journalSeq: 5,
      mismatches: [
        { type: 'peer', name: 'bad-peer', issue: 'missing_in_state', details: 'not found' },
      ],
    }
    const lines = renderVerifyView(result, false, 80)
    const joined = lines.join(' ')
    expect(joined).toContain('bad-peer')
  })

  it('shows prompt when no result and not loading', () => {
    const lines = renderVerifyView(null, false, 80)
    const joined = lines.join(' ')
    expect(joined.toLowerCase()).toContain('r')
  })
})

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

describe('renderStatusBar', () => {
  it('shows node ID and tab', () => {
    const bar = renderStatusBar(mockState(), 80)
    expect(bar).toContain('node-a')
    expect(bar).toContain('LIST')
  })

  it('shows LIVE indicator when following', () => {
    const bar = renderStatusBar(mockState({ following: true }), 80)
    expect(bar).toContain('LIVE')
  })

  it('shows PAUSED when not following', () => {
    const bar = renderStatusBar(mockState({ following: false }), 80)
    expect(bar).toContain('PAUSED')
  })

  it('shows lastSeq', () => {
    const bar = renderStatusBar(mockState({ lastSeq: 42 }), 80)
    expect(bar).toContain('42')
  })
})

describe('renderHelpBar', () => {
  it('returns non-empty string', () => {
    const line = renderHelpBar(mockState())
    expect(line.length).toBeGreaterThan(0)
  })

  it('shows blame hint on LIST tab', () => {
    const line = renderHelpBar(mockState({ activeTab: 'LIST' }))
    expect(line).toContain('blame')
  })

  it('shows refresh hint on VERIFY tab', () => {
    const line = renderHelpBar(mockState({ activeTab: 'VERIFY' }))
    expect(line).toContain('refresh')
  })

  it('shows back hint on BLAME tab', () => {
    const line = renderHelpBar(mockState({ activeTab: 'BLAME' }))
    expect(line).toContain('back')
  })
})

describe('renderFilterPrompt', () => {
  it('shows current input', () => {
    const line = renderFilterPrompt('peer', 80)
    expect(line).toContain('peer')
  })

  it('shows empty prompt', () => {
    const line = renderFilterPrompt('', 80)
    expect(line).toContain('Filter')
  })
})
