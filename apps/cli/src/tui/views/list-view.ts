import { ANSI, truncate, padRight } from '../render.js'
import { relativeTime } from '../../output.js'
import { isSystemAction } from '../../handlers/node-log-handlers.js'
import type { LogEntry } from '../../clients/orchestrator-client.js'

/**
 * Render the entry list panel. Returns an array of rendered lines.
 */
export function renderListView(
  entries: LogEntry[],
  cursor: number,
  height: number,
  width: number,
  filter?: string
): string[] {
  if (entries.length === 0) {
    return ['', `  ${ANSI.dim}No entries${filter ? ` matching "${filter}"` : ''}.${ANSI.reset}`, '']
  }

  // Column widths
  const seqW = 5
  const ageW = 10
  const actionW = 28
  const entityW = Math.max(10, width - seqW - ageW - actionW - 8)

  // Header
  const header = `  ${ANSI.bold}${padRight('Seq', seqW)} ${padRight('Age', ageW)} ${padRight('Action', actionW)} ${padRight('Entity', entityW)}${ANSI.reset}`

  // Visible window
  const scrollOffset = Math.max(0, cursor - height + 3)
  const visibleEntries = entries.slice(scrollOffset, scrollOffset + height - 2)

  const lines: string[] = [header]

  for (let i = 0; i < visibleEntries.length; i++) {
    const e = visibleEntries[i]
    const idx = scrollOffset + i
    const isCursor = idx === cursor

    const seq = String(e.seq).padStart(seqW - 1)
    const age = padRight(relativeTime(e.recorded_at), ageW)
    const action = padRight(e.action.action, actionW)
    const entity = truncate(extractPrimaryName(e), entityW)

    // Color by action type
    let actionColor: string = ANSI.cyan
    if (e.action.action.includes('delete')) actionColor = ANSI.red
    if (e.action.action.startsWith('internal:protocol')) actionColor = ANSI.magenta
    if (isSystemAction(e.action.action)) actionColor = ANSI.dim

    const reset = ANSI.reset

    if (isCursor) {
      // Inverse video for the entire selected row — visible on any terminal
      const line = `\u25b8 ${seq} ${age} ${action} ${entity}`
      lines.push(`${ANSI.inverse}${ANSI.bold}${line}${reset}`)
    } else {
      lines.push(
        `  ${ANSI.gray}${seq}${reset} ${ANSI.dim}${age}${reset} ${actionColor}${action}${reset} ${entity}`
      )
    }
  }

  // Scroll indicator
  if (entries.length > height - 2) {
    const pct = Math.round(((cursor + 1) / entries.length) * 100)
    lines.push(`${ANSI.dim}  ${entries.length} entries (${pct}%)${ANSI.reset}`)
  }

  return lines
}

function extractPrimaryName(entry: LogEntry): string {
  const data = entry.action.data
  if (!data || typeof data !== 'object') return ''
  const obj = data as Record<string, unknown>

  if ('name' in obj && typeof obj.name === 'string') return obj.name
  if ('peerInfo' in obj && typeof obj.peerInfo === 'object' && obj.peerInfo !== null) {
    const pi = obj.peerInfo as Record<string, unknown>
    if ('name' in pi && typeof pi.name === 'string') return pi.name
  }
  return ''
}
