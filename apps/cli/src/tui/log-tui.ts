import { createOrchestratorClient } from '../clients/orchestrator-client.js'
import type { LogEntry, VerifyResult } from '../clients/orchestrator-client.js'
import {
  isSystemAction,
  extractEntityNames,
  computeDiffSummary,
  DEFAULT_POLL_INTERVAL_MS,
} from '../handlers/node-log-handlers.js'
import type { DiffSummary } from '../handlers/node-log-handlers.js'
import {
  clearScreen,
  hideCursor,
  showCursor,
  moveTo,
  clearLine,
  boxDivider,
  getTermSize,
  ANSI,
} from './render.js'
import { renderStatusBar } from './components/status-bar.js'
import { renderHelpBar } from './components/help-bar.js'
import { renderFilterPrompt } from './components/filter-prompt.js'
import { renderListView } from './views/list-view.js'
import { renderDetailView } from './views/detail-view.js'
import { renderBlameView } from './views/blame-view.js'
import { renderDiffView } from './views/diff-view.js'
import { renderVerifyView } from './views/verify-view.js'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type Tab = 'LIST' | 'BLAME' | 'DIFF' | 'VERIFY'

export interface TuiState {
  activeTab: Tab
  entries: LogEntry[]
  cursor: number
  detailOpen: boolean
  following: boolean
  showSystem: boolean
  lastSeq: number
  nodeId: string
  filter: string
  filterMode: boolean
  filterInput: string

  // Blame
  blameName: string
  blameEntries: LogEntry[]
  blameCursor: number

  // Diff
  diffMarks: number[] // seq numbers
  diffResult: DiffSummary | null

  // Verify
  verifyResult: VerifyResult | null
  verifyLoading: boolean
}

function initialState(): TuiState {
  return {
    activeTab: 'LIST',
    entries: [],
    cursor: 0,
    detailOpen: false,
    following: false,
    showSystem: false,
    lastSeq: 0,
    nodeId: '',
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
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function launchTui(opts: {
  token: string
  orchestratorUrl?: string
  interval?: number
}): Promise<void> {
  const state = initialState()
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  const pollInterval = opts.interval || DEFAULT_POLL_INTERVAL_MS

  // Connect
  const orchestrator = await createOrchestratorClient(opts.orchestratorUrl)
  const logResult = await orchestrator.getLogClient(opts.token)
  if (!logResult.success) {
    console.error(`[error] ${logResult.error}`)
    process.exit(1)
  }
  const logClient = logResult.client

  // Initial fetch
  const allEntries = await logClient.listEntries()
  state.entries = allEntries
  state.lastSeq = await logClient.lastSeq()
  if (allEntries.length > 0) {
    state.nodeId = allEntries[0].nodeId
  }

  // Setup terminal — suppress stderr so OTel/telemetry errors don't corrupt the TUI
  const originalStderrWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = (() => true) as typeof process.stderr.write

  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf-8')
  process.stdout.write(hideCursor())
  process.stdout.write(clearScreen())

  // Render
  function render() {
    const { rows, cols } = getTermSize()
    const lines: string[] = []

    // Status bar (row 1)
    lines.push(renderStatusBar(state, cols))

    // Divider
    lines.push(`${ANSI.dim}${boxDivider(cols)}${ANSI.reset}`)

    // Main content area — detail panel takes up to 40% of screen when open
    const detailHeight = state.detailOpen ? Math.max(8, Math.floor(rows * 0.4)) : 0
    const helpHeight = 2 // divider + help
    const filterHeight = state.filterMode ? 1 : 0
    const contentHeight = rows - 2 - detailHeight - helpHeight - filterHeight

    const filteredEntries = getFilteredEntries(state)

    if (state.activeTab === 'LIST') {
      const listLines = renderListView(
        filteredEntries,
        state.cursor,
        contentHeight,
        cols,
        state.filter
      )
      lines.push(...listLines)
    } else if (state.activeTab === 'BLAME') {
      const blameLines = renderBlameView(
        state.blameName,
        state.blameEntries,
        state.blameCursor,
        contentHeight,
        cols
      )
      lines.push(...blameLines)
    } else if (state.activeTab === 'DIFF') {
      const diffLines = renderDiffView(state.diffResult, cols)
      lines.push(...diffLines)
    } else if (state.activeTab === 'VERIFY') {
      const verifyLines = renderVerifyView(state.verifyResult, state.verifyLoading, cols)
      lines.push(...verifyLines)
    }

    // Detail panel
    if (state.detailOpen) {
      lines.push(`${ANSI.dim}${boxDivider(cols)}${ANSI.reset}`)
      const selectedEntry =
        state.activeTab === 'BLAME'
          ? state.blameEntries[state.blameCursor] || null
          : filteredEntries[state.cursor] || null
      const detailLines = renderDetailView(selectedEntry, cols)
      lines.push(...detailLines.slice(0, detailHeight - 1))
    }

    // Filter prompt
    if (state.filterMode) {
      lines.push(renderFilterPrompt(state.filterInput, cols))
    }

    // Help bar
    lines.push(`${ANSI.dim}${boxDivider(cols)}${ANSI.reset}`)
    lines.push(renderHelpBar(state))

    // Write to screen
    let output = moveTo(1, 1)
    for (let i = 0; i < rows; i++) {
      output += clearLine()
      if (i < lines.length) {
        output += lines[i]
      }
      if (i < rows - 1) output += '\n'
    }
    process.stdout.write(output)
  }

  // Poll for new entries
  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(async () => {
      if (!state.following) return
      try {
        const newEntries = await logClient.listEntries({ afterSeq: state.lastSeq })
        if (newEntries.length > 0) {
          state.entries.push(...newEntries)
          state.lastSeq = Math.max(...newEntries.map((e) => e.seq))
          render()
        }
      } catch {
        // Silently continue — connection may have dropped
      }
    }, pollInterval)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  // Cleanup
  function cleanup() {
    stopPolling()
    process.stderr.write = originalStderrWrite // restore stderr
    process.stdout.write(showCursor())
    process.stdout.write(clearScreen())
    process.stdout.write(moveTo(1, 1))
    process.stdin.setRawMode(false)
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('SIGWINCH', render)

  // Keyboard handler
  process.stdin.on('data', async (data: string) => {
    const key = data

    // Filter mode captures all input
    if (state.filterMode) {
      if (key === '\r' || key === '\n') {
        // Apply filter
        state.filter = state.filterInput
        state.filterMode = false
        state.cursor = 0
        render()
        return
      }
      if (key === '\x1b') {
        // Escape — cancel filter
        state.filterMode = false
        state.filterInput = state.filter // restore previous
        render()
        return
      }
      if (key === '\x7f' || key === '\b') {
        // Backspace
        state.filterInput = state.filterInput.slice(0, -1)
        render()
        return
      }
      if (key.length === 1 && key >= ' ') {
        state.filterInput += key
        render()
        return
      }
      return
    }

    const filtered = getFilteredEntries(state)
    const maxCursor =
      state.activeTab === 'BLAME' ? state.blameEntries.length - 1 : filtered.length - 1

    // Navigation
    if (key === '\x1b[A' || key === 'k') {
      // Up
      if (state.activeTab === 'BLAME') {
        state.blameCursor = Math.max(0, state.blameCursor - 1)
      } else {
        state.cursor = Math.max(0, state.cursor - 1)
      }
      render()
      return
    }
    if (key === '\x1b[B' || key === 'j') {
      // Down
      if (state.activeTab === 'BLAME') {
        state.blameCursor = Math.min(
          Math.max(0, state.blameEntries.length - 1),
          state.blameCursor + 1
        )
      } else {
        state.cursor = Math.min(Math.max(0, maxCursor), state.cursor + 1)
      }
      render()
      return
    }
    if (key === 'g') {
      state.cursor = 0
      state.blameCursor = 0
      render()
      return
    }
    if (key === 'G') {
      state.cursor = Math.max(0, maxCursor)
      state.blameCursor = Math.max(0, state.blameEntries.length - 1)
      render()
      return
    }

    // Enter — toggle detail
    if (key === '\r' || key === '\n') {
      state.detailOpen = !state.detailOpen
      render()
      return
    }

    // Tab — cycle tabs
    if (key === '\t') {
      const tabs: Tab[] = ['LIST', 'BLAME', 'DIFF', 'VERIFY']
      const idx = tabs.indexOf(state.activeTab)
      state.activeTab = tabs[(idx + 1) % tabs.length]
      render()
      return
    }

    // Escape — back to list
    if (key === '\x1b' && state.activeTab !== 'LIST') {
      state.activeTab = 'LIST'
      render()
      return
    }

    // / — enter filter mode
    if (key === '/') {
      state.filterMode = true
      state.filterInput = state.filter
      render()
      return
    }

    // f — toggle follow
    if (key === 'f' && state.activeTab === 'LIST') {
      state.following = !state.following
      if (state.following) {
        startPolling()
      } else {
        stopPolling()
      }
      render()
      return
    }

    // s — toggle system events
    if (key === 's' && state.activeTab === 'LIST') {
      state.showSystem = !state.showSystem
      state.cursor = 0
      render()
      return
    }

    // b — blame
    if (key === 'b' && state.activeTab === 'LIST') {
      const entry = filtered[state.cursor]
      if (entry) {
        const names = extractEntityNames(entry)
        if (names.length > 0) {
          state.blameName = names[0]
          state.blameEntries = state.entries.filter((e) => {
            const eNames = extractEntityNames(e)
            return eNames.includes(state.blameName)
          })
          state.blameCursor = 0
          state.activeTab = 'BLAME'
          render()
          return
        }
      }
    }

    // m — mark for diff
    if (key === 'm' && (state.activeTab === 'LIST' || state.activeTab === 'DIFF')) {
      const entry = filtered[state.cursor]
      if (entry) {
        state.diffMarks.push(entry.seq)
        if (state.diffMarks.length >= 2) {
          const seqs = state.diffMarks.sort((a, b) => a - b)
          const fromSeq = seqs[0]
          const toSeq = seqs[seqs.length - 1]

          // Compute diff using shared function
          const rangeEntries = state.entries.filter((e) => e.seq > fromSeq && e.seq <= toSeq)
          if (rangeEntries.length > 0) {
            state.diffResult = computeDiffSummary(rangeEntries, fromSeq, toSeq)
            state.activeTab = 'DIFF'
          }
          state.diffMarks = []
        }
        render()
        return
      }
    }

    // r — refresh verify
    if (key === 'r' && state.activeTab === 'VERIFY') {
      state.verifyLoading = true
      render()
      try {
        state.verifyResult = await logClient.verify()
      } catch (err) {
        state.verifyResult = {
          consistent: false,
          journalSeq: state.lastSeq,
          mismatches: [
            {
              type: 'peer',
              name: '',
              issue: 'field_mismatch',
              details: err instanceof Error ? err.message : String(err),
            },
          ],
        }
      }
      state.verifyLoading = false
      render()
      return
    }

    // q — quit
    if (key === 'q') {
      cleanup()
      return
    }
  })

  // Initial render — start paused, user presses 'f' to enable live polling
  render()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFilteredEntries(state: TuiState): LogEntry[] {
  let entries = state.entries

  if (!state.showSystem) {
    entries = entries.filter((e) => !isSystemAction(e.action.action))
  }

  if (state.filter) {
    const f = state.filter.toLowerCase()
    entries = entries.filter((e) => {
      if (e.action.action.toLowerCase().includes(f)) return true
      const names = extractEntityNames(e)
      if (names.some((n) => n.toLowerCase().includes(f))) return true
      return false
    })
  }

  return entries
}
