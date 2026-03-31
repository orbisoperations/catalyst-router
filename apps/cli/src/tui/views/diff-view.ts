import { ANSI } from '../render.js'
import type { DiffSummary } from '../../handlers/node-log-handlers.js'

/**
 * Render the diff/shift-handover view.
 */
export function renderDiffView(diff: DiffSummary | null, _width: number): string[] {
  if (!diff) {
    return [
      `  ${ANSI.dim}Press ${ANSI.bold}m${ANSI.reset}${ANSI.dim} on two entries to mark a range, then switch to DIFF tab.${ANSI.reset}`,
    ]
  }

  const lines: string[] = []
  const i = '  '

  lines.push(`${i}${ANSI.bold}Shift Handover Summary${ANSI.reset}`)
  lines.push('')
  lines.push(
    `${i}${ANSI.dim}Period:${ANSI.reset}  ${diff.fromTime} \u2192 ${diff.toTime} (${diff.duration})`
  )
  lines.push(
    `${i}${ANSI.dim}Entries:${ANSI.reset} ${diff.totalEntries} total (${diff.operatorEntries} operator, ${diff.systemEntries} system)`
  )
  lines.push('')
  lines.push(
    `${i}${ANSI.dim}Peers:${ANSI.reset}   ${ANSI.green}+${diff.peersCreated.length} created${ANSI.reset}, ${ANSI.red}-${diff.peersDeleted.length} deleted${ANSI.reset}`
  )
  lines.push(
    `${i}${ANSI.dim}Routes:${ANSI.reset}  ${ANSI.green}+${diff.routesCreated.length} created${ANSI.reset}, ${ANSI.red}-${diff.routesDeleted.length} deleted${ANSI.reset}`
  )

  if (diff.operatorActions.length > 0) {
    lines.push('')
    lines.push(`${i}${ANSI.dim}Operator actions:${ANSI.reset}`)
    for (const a of diff.operatorActions) {
      const actionColor = a.action.includes('delete') ? ANSI.red : ANSI.cyan
      lines.push(
        `${i}  ${ANSI.gray}[${a.seq}]${ANSI.reset} ${actionColor}${a.action.padEnd(25)}${ANSI.reset} ${a.entity}`
      )
    }
  }

  return lines
}
