import { describe, it, expect } from 'bun:test'
import { TickMessageSchema } from '../../src/system/actions.js'
import { ActionSchema } from '../../src/schema.js'
import { Actions } from '../../src/action-types.js'

describe('TickMessageSchema', () => {
  it('parses a valid tick action', () => {
    const result = TickMessageSchema.safeParse({
      action: 'system:tick',
      data: { now: Date.now() },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.action).toBe(Actions.Tick)
      expect(result.data.data.now).toBeGreaterThan(0)
    }
  })

  it('rejects tick with missing now field', () => {
    const result = TickMessageSchema.safeParse({
      action: 'system:tick',
      data: {},
    })
    expect(result.success).toBe(false)
  })

  it('rejects tick with non-numeric now', () => {
    const result = TickMessageSchema.safeParse({
      action: 'system:tick',
      data: { now: 'not-a-number' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects tick with missing data', () => {
    const result = TickMessageSchema.safeParse({
      action: 'system:tick',
    })
    expect(result.success).toBe(false)
  })

  it('rejects tick with wrong action type', () => {
    const result = TickMessageSchema.safeParse({
      action: 'system:wrong',
      data: { now: Date.now() },
    })
    expect(result.success).toBe(false)
  })
})

describe('ActionSchema includes Tick', () => {
  it('parses tick through the unified ActionSchema', () => {
    const result = ActionSchema.safeParse({
      action: 'system:tick',
      data: { now: 1707745200000 },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.action).toBe(Actions.Tick)
    }
  })

  it('Actions.Tick has the correct value', () => {
    expect(Actions.Tick).toBe('system:tick')
  })
})
