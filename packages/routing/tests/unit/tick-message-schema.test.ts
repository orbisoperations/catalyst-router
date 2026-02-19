import { describe, it, expect } from 'bun:test'
import { TickMessageSchema } from '../../src/system/actions.js'
import { Actions } from '../../src/action-types.js'

describe('TickMessageSchema', () => {
  it('accepts valid tick action with numeric now timestamp', () => {
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
})
