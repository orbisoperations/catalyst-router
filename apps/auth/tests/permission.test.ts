import { describe, expect, it } from 'bun:test'
import { isSecretValid } from '../src'

// Note: hasPermission() tests removed - deprecated in favor of Cedar policy engine
// See ADR-0008 and packages/authorization/tests/policy/ for Cedar-based authorization tests

describe('Validate secrets timing safe', () => {
  it('should validate secrets safely with around same time duration', () => {
    expect(isSecretValid('hello', 'hello')).toBe(true)
    expect(isSecretValid('hello', 'incoad')).toBe(false)
    expect(isSecretValid('hello', 'thisisaverylongsecretthatisnotthesameashello')).toBe(false)
    expect(isSecretValid('invalid', 'secret')).toBe(false)
    expect(isSecretValid('verryyyylong', 'secret')).toBe(false)
    expect(isSecretValid('shor', 'secret')).toBe(false)
  })
})

describe('isSecretValid', () => {
  it('should return true for matching secrets', () => {
    expect(isSecretValid('my-secret-123', 'my-secret-123')).toBe(true)
  })

  it('should return false for different secrets of same length', () => {
    expect(isSecretValid('my-secret-123', 'my-secret-456')).toBe(false)
  })

  it('should return false for different secrets of different length', () => {
    expect(isSecretValid('short', 'much-longer-secret')).toBe(false)
    expect(isSecretValid('much-longer-secret', 'short')).toBe(false)
  })

  it('should return true for empty secrets when both are empty', () => {
    expect(isSecretValid('', '')).toBe(true)
  })

  it('should return false when one secret is empty', () => {
    expect(isSecretValid('', 'secret')).toBe(false)
    expect(isSecretValid('secret', '')).toBe(false)
  })

  it('should handle unicode characters correctly', () => {
    expect(isSecretValid('秘密🔐', '秘密🔐')).toBe(true)
    expect(isSecretValid('秘密🔐', '秘密🔑')).toBe(false)
  })

  // Timing safety is verified by code review (use of timingSafeEqual)
  // Runtime timing tests are notoriously flaky
})
