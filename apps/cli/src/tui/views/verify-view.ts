import { ANSI } from '../render.js'
import type { VerifyResult } from '../../clients/orchestrator-client.js'

/**
 * Render the verify view — journal vs route table consistency.
 */
export function renderVerifyView(
  result: VerifyResult | null,
  loading: boolean,
  _width: number
): string[] {
  if (loading) {
    return [`  ${ANSI.dim}Verifying journal consistency...${ANSI.reset}`]
  }

  if (!result) {
    return [
      `  ${ANSI.dim}Press ${ANSI.bold}r${ANSI.reset}${ANSI.dim} to run journal verification against the live route table.${ANSI.reset}`,
    ]
  }

  const lines: string[] = []
  const i = '  '

  lines.push(`${i}${ANSI.bold}Journal Verification${ANSI.reset}`)
  lines.push(`${i}${ANSI.dim}Seq:${ANSI.reset} ${result.journalSeq}`)
  lines.push('')

  if (result.consistent) {
    lines.push(`${i}${ANSI.green}\u2713 Route table consistent with journal${ANSI.reset}`)
  } else {
    lines.push(`${i}${ANSI.red}\u2717 ${result.mismatches.length} mismatch(es) found:${ANSI.reset}`)
    lines.push('')
    for (const m of result.mismatches) {
      const icon =
        m.issue === 'missing_in_journal' ? '?' : m.issue === 'missing_in_state' ? '!' : '\u2260'
      const issueText = m.issue.replace(/_/g, ' ')
      lines.push(
        `${i}  ${ANSI.yellow}${icon}${ANSI.reset} ${m.type} ${ANSI.bold}"${m.name}"${ANSI.reset} \u2014 ${issueText}${m.details ? ` ${ANSI.dim}(${m.details})${ANSI.reset}` : ''}`
      )
    }
  }

  return lines
}
