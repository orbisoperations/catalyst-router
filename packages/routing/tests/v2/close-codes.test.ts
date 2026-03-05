import { describe, it, expect } from 'vitest'
import { CloseCodes } from '../../src/v2/close-codes.js'

describe('CloseCodes', () => {
  it('has correct numeric values', () => {
    expect(CloseCodes.NORMAL).toBe(1)
    expect(CloseCodes.HOLD_EXPIRED).toBe(2)
    expect(CloseCodes.TRANSPORT_ERROR).toBe(3)
    expect(CloseCodes.ADMIN_SHUTDOWN).toBe(4)
    expect(CloseCodes.PROTOCOL_ERROR).toBe(5)
  })

  it('has exactly 5 codes', () => {
    expect(Object.keys(CloseCodes)).toHaveLength(5)
  })
})
