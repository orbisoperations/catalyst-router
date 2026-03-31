import { ANSI } from '../render.js'
import type { TuiState } from '../log-tui.js'

const TABS = ['LIST', 'BLAME', 'DIFF', 'VERIFY'] as const

export function renderStatusBar(state: TuiState, _width: number): string {
  // Tab bar — active tab in bold inverse, inactive in brackets
  const tabs = TABS.map((t) => {
    if (t === state.activeTab) {
      return `${ANSI.bold}${ANSI.inverse} ${t} ${ANSI.reset}`
    }
    return `${ANSI.dim}[${t}]${ANSI.reset}`
  }).join(' ')

  // Right side: live indicator + seq
  const liveIndicator = state.following
    ? `${ANSI.green}\u25cf LIVE${ANSI.reset}`
    : `${ANSI.yellow}\u25cb PAUSED${ANSI.reset}`
  const seqInfo = `seq: ${state.lastSeq}`

  const nodeId = state.nodeId ? `${ANSI.blue}${state.nodeId}${ANSI.reset}` : ''

  return `${tabs}  ${liveIndicator}  ${seqInfo}${nodeId ? `  ${nodeId}` : ''}`
}
