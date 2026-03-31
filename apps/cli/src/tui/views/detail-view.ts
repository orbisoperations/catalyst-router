import { ANSI } from '../render.js'
import { relativeTime } from '../../output.js'
import type { LogEntry } from '../../clients/orchestrator-client.js'

/**
 * Render the detail panel for a single entry. Returns an array of lines.
 */
export function renderDetailView(entry: LogEntry | null, _width: number): string[] {
  if (!entry) {
    return [`  ${ANSI.dim}Select an entry and press Enter to view details.${ANSI.reset}`]
  }

  const lines: string[] = []
  const indent = '  '

  lines.push(`${indent}${ANSI.bold}Entry #${entry.seq}${ANSI.reset}`)
  lines.push(
    `${indent}${ANSI.dim}Time:${ANSI.reset}    ${entry.recorded_at} ${ANSI.dim}(${relativeTime(entry.recorded_at)})${ANSI.reset}`
  )
  lines.push(
    `${indent}${ANSI.dim}Action:${ANSI.reset}  ${ANSI.cyan}${entry.action.action}${ANSI.reset}`
  )
  lines.push(`${indent}${ANSI.dim}NodeId:${ANSI.reset}  ${entry.nodeId}`)
  if (entry.traceId) {
    lines.push(
      `${indent}${ANSI.dim}TraceId:${ANSI.reset} ${ANSI.blue}${entry.traceId}${ANSI.reset}`
    )
  }

  if (entry.action.data !== undefined && entry.action.data !== null) {
    lines.push(`${indent}${ANSI.dim}Data:${ANSI.reset}`)
    const json = JSON.stringify(entry.action.data, null, 2)
    for (const line of json.split('\n')) {
      lines.push(`${indent}  ${ANSI.white}${line}${ANSI.reset}`)
    }
  } else {
    lines.push(`${indent}${ANSI.dim}Data:    (none)${ANSI.reset}`)
  }

  return lines
}
