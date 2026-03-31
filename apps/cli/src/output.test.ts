import { describe, it, expect } from 'vitest'
import { relativeTime, parseTimeExpr, parseOutputFormat, formatDuration } from './output.js'

describe('relativeTime', () => {
  it('returns relative time for past timestamps', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(relativeTime(fiveMinAgo)).toBe('5m ago')
  })

  it('handles future timestamps (clock skew)', () => {
    const fiveMinAhead = new Date(Date.now() + 5 * 60_000).toISOString()
    const result = relativeTime(fiveMinAhead)
    expect(result).toContain('ahead')
  })

  it('returns raw string for invalid dates', () => {
    expect(relativeTime('not-a-date')).toBe('not-a-date')
  })

  it('formats hours correctly', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    expect(relativeTime(twoHoursAgo)).toBe('2h ago')
  })

  it('formats days correctly', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString()
    expect(relativeTime(threeDaysAgo)).toBe('3d ago')
  })
})

describe('parseTimeExpr', () => {
  it('parses "0s" as now (not null)', () => {
    const result = parseTimeExpr('0s')
    expect(result).not.toBeNull()
    // Should be very close to now
    expect(Math.abs(result!.getTime() - Date.now())).toBeLessThan(1000)
  })

  it('parses "0m" as now', () => {
    const result = parseTimeExpr('0m')
    expect(result).not.toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseTimeExpr('')).toBeNull()
  })

  it('returns null for random garbage', () => {
    expect(parseTimeExpr('asdfghjkl')).toBeNull()
  })

  it('parses "1w" as 1 week ago', () => {
    const result = parseTimeExpr('1w')
    expect(result).not.toBeNull()
    const expectedMs = 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(Date.now() - result!.getTime() - expectedMs)).toBeLessThan(1000)
  })
})

describe('parseOutputFormat', () => {
  it('returns table by default', () => {
    expect(parseOutputFormat({})).toBe('table')
  })

  it('parses json', () => {
    expect(parseOutputFormat({ output: 'json' })).toBe('json')
  })

  it('parses jsonl', () => {
    expect(parseOutputFormat({ output: 'jsonl' })).toBe('jsonl')
  })

  it('defaults to table for unknown format', () => {
    expect(parseOutputFormat({ output: 'xml' })).toBe('table')
  })

  it('handles undefined output', () => {
    expect(parseOutputFormat({ output: undefined })).toBe('table')
  })
})

describe('formatDuration', () => {
  it('handles 0ms', () => {
    expect(formatDuration(0)).toBe('0s')
  })

  it('handles negative (clock skew)', () => {
    // Should not crash
    const result = formatDuration(-5000)
    expect(typeof result).toBe('string')
  })
})
