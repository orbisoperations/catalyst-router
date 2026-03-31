export type OutputFormat = 'table' | 'json' | 'jsonl'

/**
 * Format a timestamp as a relative time string (e.g., "2m ago", "3h ago").
 * Falls back to the raw ISO string if parsing fails.
 */
export function relativeTime(isoString: string): string {
  const now = Date.now()
  const then = new Date(isoString).getTime()
  if (isNaN(then)) return isoString

  const diffMs = now - then
  if (diffMs < 0) return `+${Math.ceil(-diffMs / 1000)}s ahead`

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s ago`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`

  const years = Math.floor(months / 12)
  return `${years}y ago`
}

/**
 * Print a single object as JSON or a formatted key-value display.
 */
/**
 * Add the --output option to a commander Command and return a helper
 * to read the chosen format from parsed options.
 */
export function addOutputOption(cmd: {
  option: (flags: string, desc: string, defaultVal: string) => unknown
}): void {
  cmd.option('--output <format>', 'Output format: table, json, or jsonl', 'table')
}

/**
 * Parse the output format from options, defaulting to table.
 */
export function parseOutputFormat(options: { output?: string }): OutputFormat {
  const fmt = options.output?.toLowerCase()
  if (fmt === 'json' || fmt === 'jsonl') return fmt
  return 'table'
}

/**
 * Duration unit multipliers in milliseconds.
 */
const DURATION_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

/**
 * Parse a time expression into a Date. Accepts:
 * - Relative durations: "2h", "30m", "1d", "6h30m"
 * - ISO 8601 timestamps: "2026-03-24T00:00:00Z"
 * - "now"
 *
 * Returns null if the input can't be parsed.
 */
export function parseTimeExpr(input: string): Date | null {
  const trimmed = input.trim().toLowerCase()
  if (trimmed === 'now') return new Date()

  // Try relative duration: "2h", "30m", "1d", "6h30m", "2h15m"
  const durationPattern = /^(\d+[smhdw])+$/
  if (durationPattern.test(trimmed)) {
    let totalMs = 0
    const parts = trimmed.matchAll(/(\d+)([smhdw])/g)
    for (const [, amount, unit] of parts) {
      totalMs += Number(amount) * DURATION_UNITS[unit]
    }
    if (totalMs >= 0) {
      return new Date(Date.now() - totalMs)
    }
  }

  // Try ISO 8601 timestamp
  const date = new Date(input)
  if (!isNaN(date.getTime())) return date

  return null
}

/**
 * Format a duration in milliseconds as a human-readable string.
 * e.g., 3_661_000 → "1h 1m"
 */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < 60_000) return `${Math.floor(abs / 1000)}s`
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m`

  const hours = Math.floor(abs / 3_600_000)
  const minutes = Math.floor((abs % 3_600_000) / 60_000)

  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
  }

  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}
