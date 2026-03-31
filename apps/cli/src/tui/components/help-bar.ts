import { ANSI } from '../render.js'
import type { TuiState } from '../log-tui.js'

const KEY_STYLE = `${ANSI.bold}${ANSI.cyan}`
const DESC_STYLE = `${ANSI.dim}`
const R = ANSI.reset

function key(k: string, desc: string): string {
  return `${KEY_STYLE}${k}${R}${DESC_STYLE} ${desc}${R}`
}

export function renderHelpBar(state: TuiState): string {
  const common = [
    key('\u2191\u2193', 'navigate'),
    key('Enter', state.detailOpen ? 'collapse' : 'expand'),
    key('/', 'filter'),
    key('Tab', 'tab'),
    key('q', 'quit'),
  ]

  if (state.activeTab === 'LIST') {
    return [
      ...common,
      key('f', state.following ? 'pause' : 'follow'),
      key('s', state.showSystem ? 'hide sys' : 'show sys'),
      key('b', 'blame selected'),
    ].join('  ')
  }

  if (state.activeTab === 'BLAME') {
    return [...common, key('Esc', 'back to list')].join('  ')
  }

  if (state.activeTab === 'DIFF') {
    return [...common, key('m', 'mark'), key('Esc', 'back to list')].join('  ')
  }

  if (state.activeTab === 'VERIFY') {
    return [...common, key('r', 'refresh'), key('Esc', 'back to list')].join('  ')
  }

  return common.join('  ')
}
