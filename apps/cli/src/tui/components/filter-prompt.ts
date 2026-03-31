import { ANSI } from '../render.js'

export function renderFilterPrompt(input: string, width: number): string {
  const prompt = `${ANSI.bold}/${ANSI.reset} ${input}${ANSI.dim}\u2588${ANSI.reset}`
  const padding = Math.max(0, width - input.length - 4)
  return `${ANSI.bgBlue}${ANSI.white} Filter: ${prompt}${' '.repeat(padding)}${ANSI.reset}`
}
