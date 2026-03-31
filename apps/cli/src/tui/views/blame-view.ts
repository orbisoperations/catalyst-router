import { ANSI, padRight } from '../render.js'
import { relativeTime } from '../../output.js'
import type { LogEntry } from '../../clients/orchestrator-client.js'

/**
 * Render the blame view — history for a specific entity.
 */
export function renderBlameView(
  name: string,
  entries: LogEntry[],
  cursor: number,
  height: number,
  _width: number
): string[] {
  const lines: string[] = []

  lines.push(
    `  ${ANSI.bold}History for "${ANSI.cyan}${name}${ANSI.reset}${ANSI.bold}" (${entries.length} entries)${ANSI.reset}`
  )
  lines.push('')

  if (entries.length === 0) {
    lines.push(`  ${ANSI.dim}No journal entries found for "${name}".${ANSI.reset}`)
    return lines
  }

  const scrollOffset = Math.max(0, cursor - height + 4)
  const visible = entries.slice(scrollOffset, scrollOffset + height - 3)

  for (let i = 0; i < visible.length; i++) {
    const e = visible[i]
    const idx = scrollOffset + i
    const isCursor = idx === cursor

    const pointer = isCursor ? `${ANSI.bold}\u25b8 ` : '  '
    const seq = `${ANSI.gray}[${e.seq}]${ANSI.reset}`
    const age = `${ANSI.dim}${padRight(relativeTime(e.recorded_at), 10)}${ANSI.reset}`
    const action = `${ANSI.cyan}${e.action.action}${ANSI.reset}`

    lines.push(`${pointer}${seq} ${age} ${action}`)
  }

  return lines
}
