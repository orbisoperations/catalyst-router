import { describe, it, expect } from 'bun:test'
import { ActionSchema } from '../../src/schema.js'
import { Actions } from '../../src/action-types.js'

describe('ActionSchema', () => {
  it('accepts system:tick via unified ActionSchema', () => {
    const result = ActionSchema.safeParse({
      action: 'system:tick',
      data: { now: 1707745200000 },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.action).toBe(Actions.Tick)
    }
  })

  it('Actions.Tick equals "system:tick"', () => {
    expect(Actions.Tick).toBe('system:tick')
  })
})
