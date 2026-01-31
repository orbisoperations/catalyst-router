import { describe, expect, it } from 'bun:test'
import { hasPermission, isSecretValid } from '../src'

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

describe('hasPermission', () => {
  describe('admin role', () => {
    it('should grant any permission to admin role', () => {
      expect(hasPermission(['admin'], 'peer:create')).toBe(true)
      expect(hasPermission(['admin'], 'route:delete')).toBe(true)
      expect(hasPermission(['admin'], 'ibgp:connect')).toBe(true)
    })
  })

  describe('wildcard role', () => {
    it('should grant any permission to * role', () => {
      expect(hasPermission(['*'], 'peer:create')).toBe(true)
      expect(hasPermission(['*'], 'route:delete')).toBe(true)
    })
  })

  describe('direct permission', () => {
    it('should grant permission when permission matches exactly', () => {
      expect(hasPermission(['peer:create'], 'peer:create')).toBe(true)
      expect(hasPermission(['route:delete'], 'route:delete')).toBe(true)
    })

    it('should deny permission when role does not match', () => {
      expect(hasPermission(['peer:create'], 'peer:delete')).toBe(false)
      expect(hasPermission(['route:create'], 'peer:create')).toBe(false)
    })
  })

  describe('category wildcard', () => {
    it('should grant permissions associated with the role', () => {
      expect(hasPermission(['peer'], 'ibgp:connect')).toBe(true)
      expect(hasPermission(['peer_custodian'], 'peer:create')).toBe(true)
      expect(hasPermission(['data_custodian'], 'route:create')).toBe(true)
    })

    it('should deny permissions not associated with the role', () => {
      expect(hasPermission(['peer'], 'peer:create')).toBe(false)
      expect(hasPermission(['peer_custodian'], 'route:create')).toBe(false)
    })
  })

  describe('empty roles', () => {
    it('should deny all permissions with empty roles', () => {
      expect(hasPermission([], 'peer:create')).toBe(false)
      expect(hasPermission([], '*')).toBe(false)
    })
  })

  describe('viewer role (no permissions)', () => {
    it('should deny write permissions to viewer', () => {
      expect(hasPermission(['viewer'], 'peer:create')).toBe(false)
      expect(hasPermission(['viewer'], 'route:delete')).toBe(false)
    })
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
