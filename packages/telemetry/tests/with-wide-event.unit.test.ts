import { describe, it, expect, vi } from 'vitest'
import type { Logger } from '@logtape/logtape'
import { withWideEvent } from '../src/wide-event.js'

function createSpyLogger() {
  const calls: { level: string; message: string; properties: Record<string, unknown> }[] = []
  const makeSpy = (level: string) =>
    vi.fn((message: unknown, properties?: unknown) => {
      calls.push({
        level,
        message: message as string,
        properties: properties as Record<string, unknown>,
      })
    })

  const logger = {
    category: ['test'],
    parent: null,
    getChild: vi.fn(),
    with: vi.fn(),
    trace: vi.fn(),
    debug: makeSpy('debug'),
    info: makeSpy('info'),
    warn: makeSpy('warn'),
    warning: vi.fn(),
    error: makeSpy('error'),
    fatal: vi.fn(),
    emit: vi.fn(),
    isEnabledFor: vi.fn(() => true),
  } as unknown as Logger

  return { logger, calls }
}

describe('withWideEvent', () => {
  it('emits on success with outcome=success', async () => {
    const { logger, calls } = createSpyLogger()

    const result = await withWideEvent('test.op', logger, async (event) => {
      event.set('custom.field', 42)
      return 'hello'
    })

    expect(result).toBe('hello')
    expect(calls).toHaveLength(1)
    expect(calls[0].level).toBe('info')
    expect(calls[0].properties['event.name']).toBe('test.op')
    expect(calls[0].properties['custom.field']).toBe(42)
    expect(calls[0].properties['catalyst.event.outcome']).toBe('success')
  })

  it('emits on error with outcome=failure and re-throws', async () => {
    const { logger, calls } = createSpyLogger()
    const err = new Error('boom')

    await expect(
      withWideEvent('test.op', logger, async () => {
        throw err
      })
    ).rejects.toThrow('boom')

    expect(calls).toHaveLength(1)
    expect(calls[0].level).toBe('error')
    expect(calls[0].properties['catalyst.event.outcome']).toBe('failure')
    expect(calls[0].properties['exception.message']).toBe('boom')
  })

  it('emits exactly once even if callback calls emit early', async () => {
    const { logger, calls } = createSpyLogger()

    await withWideEvent('test.op', logger, async (event) => {
      event.emit()
    })

    // Idempotent — only one emission despite callback + finally both calling emit
    expect(calls).toHaveLength(1)
  })

  it('passes through the return value from the callback', async () => {
    const { logger } = createSpyLogger()

    const result = await withWideEvent('test.op', logger, async () => {
      return { data: [1, 2, 3] }
    })

    expect(result).toEqual({ data: [1, 2, 3] })
  })
})
