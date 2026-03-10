import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Static analysis test: ensure no template literal logger calls remain
 * in the V2 orchestrator source files.
 *
 * Template literal calls (e.g. logger.info`...`) produce readable messages
 * but interpolated values are NOT queryable as structured fields in Loki/Grafana.
 * All logger calls must use the string + properties form instead:
 *   logger.info("message {key}", { "event.name": "...", key: value })
 */
describe('V2 structured logging', () => {
  const v2Dir = path.resolve(__dirname, '../src/v2')

  function getV2TsFiles(): string[] {
    return fs
      .readdirSync(v2Dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(v2Dir, f))
  }

  it('should not contain any template literal logger calls (module-level logger)', () => {
    const pattern = /logger\.(info|warn|error|debug)`/g
    const violations: string[] = []

    for (const filePath of getV2TsFiles()) {
      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          violations.push(`${path.basename(filePath)}:${i + 1}: ${lines[i].trim()}`)
        }
        pattern.lastIndex = 0
      }
    }

    expect(
      violations,
      `Found template literal logger calls:\n${violations.join('\n')}`
    ).toHaveLength(0)
  })

  it('should not contain any template literal logger calls (this.telemetry.logger)', () => {
    const pattern = /this\.telemetry\.logger\.(info|warn|error|debug)`/g
    const violations: string[] = []

    for (const filePath of getV2TsFiles()) {
      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          violations.push(`${path.basename(filePath)}:${i + 1}: ${lines[i].trim()}`)
        }
        pattern.lastIndex = 0
      }
    }

    expect(
      violations,
      `Found template literal logger calls:\n${violations.join('\n')}`
    ).toHaveLength(0)
  })
})
