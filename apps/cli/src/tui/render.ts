/**
 * Raw ANSI terminal helpers. No dependencies — works over SSH on any terminal.
 */

// ---------------------------------------------------------------------------
// ANSI escape codes
// ---------------------------------------------------------------------------

export const ESC = '\x1b['

export const ANSI = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  underline: `${ESC}4m`,
  inverse: `${ESC}7m`,

  // Foreground
  black: `${ESC}30m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  gray: `${ESC}90m`,

  // Background
  bgBlack: `${ESC}40m`,
  bgRed: `${ESC}41m`,
  bgGreen: `${ESC}42m`,
  bgYellow: `${ESC}43m`,
  bgBlue: `${ESC}44m`,
  bgMagenta: `${ESC}45m`,
  bgCyan: `${ESC}46m`,
  bgWhite: `${ESC}47m`,
} as const

// ---------------------------------------------------------------------------
// Cursor and screen control
// ---------------------------------------------------------------------------

export function moveTo(row: number, col: number): string {
  return `${ESC}${row};${col}H`
}

export function clearScreen(): string {
  return `${ESC}2J${ESC}1;1H`
}

export function clearLine(): string {
  return `${ESC}2K`
}

export function hideCursor(): string {
  return `${ESC}?25l`
}

export function showCursor(): string {
  return `${ESC}?25h`
}

// ---------------------------------------------------------------------------
// Box drawing
// ---------------------------------------------------------------------------

const BOX = {
  topLeft: '\u250c',
  topRight: '\u2510',
  bottomLeft: '\u2514',
  bottomRight: '\u2518',
  horizontal: '\u2500',
  vertical: '\u2502',
  teeLeft: '\u251c',
  teeRight: '\u2524',
} as const

export function horizontalLine(width: number): string {
  return BOX.horizontal.repeat(width)
}

export function boxTop(width: number, title?: string): string {
  if (title) {
    const titleStr = ` ${title} `
    const remaining = width - 2 - titleStr.length
    const left = Math.max(1, Math.floor(remaining / 2))
    const right = Math.max(1, remaining - left)
    return `${BOX.topLeft}${BOX.horizontal.repeat(left)}${titleStr}${BOX.horizontal.repeat(right)}${BOX.topRight}`
  }
  return `${BOX.topLeft}${BOX.horizontal.repeat(width - 2)}${BOX.topRight}`
}

export function boxBottom(width: number): string {
  return `${BOX.bottomLeft}${BOX.horizontal.repeat(width - 2)}${BOX.bottomRight}`
}

export function boxDivider(width: number): string {
  return `${BOX.teeLeft}${BOX.horizontal.repeat(width - 2)}${BOX.teeRight}`
}

export function boxRow(content: string, width: number): string {
  // Strip ANSI codes for length calculation
  const visibleLen = stripAnsi(content).length
  const padding = Math.max(0, width - 2 - visibleLen)
  return `${BOX.vertical}${content}${' '.repeat(padding)}${BOX.vertical}`
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

export function truncate(str: string, maxLen: number): string {
  const visible = stripAnsi(str)
  if (visible.length <= maxLen) return str

  // Walk the original string tracking visible chars
  let visibleCount = 0
  let i = 0
  while (i < str.length && visibleCount < maxLen - 1) {
    if (str[i] === '\x1b') {
      // Skip ANSI sequence
      const end = str.indexOf('m', i)
      if (end !== -1) {
        i = end + 1
        continue
      }
    }
    visibleCount++
    i++
  }
  return str.slice(0, i) + ANSI.reset + '\u2026'
}

export function padRight(str: string, width: number): string {
  const visibleLen = stripAnsi(str).length
  if (visibleLen >= width) return str
  return str + ' '.repeat(width - visibleLen)
}

/**
 * Get terminal dimensions.
 */
export function getTermSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  }
}
