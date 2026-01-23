import { describe, it, expect } from 'bun:test'
import { getRequiredPermission, hasPermission, isSecretValid } from './permissions'
import type { Action } from './schema'

describe('getRequiredPermission', () => {
  it('should return peer:create for local:peer:create', () => {
    expect(getRequiredPermission({ action: 'local:peer:create', data: {} })).toBe('peer:create')
  })

  it('should return peer:update for local:peer:update', () => {
    expect(getRequiredPermission({ action: 'local:peer:update', data: {} })).toBe('peer:update')
  })

  it('should return peer:delete for local:peer:delete', () => {
    expect(getRequiredPermission({ action: 'local:peer:delete', data: {} })).toBe('peer:delete')
  })

  it('should return route:create for local:route:create', () => {
    expect(getRequiredPermission({ action: 'local:route:create', data: {} })).toBe('route:create')
  })

  it('should return route:delete for local:route:delete', () => {
    expect(getRequiredPermission({ action: 'local:route:delete', data: {} })).toBe('route:delete')
  })

  it('should return ibgp:connect for internal:protocol:open', () => {
    expect(getRequiredPermission({ action: 'internal:protocol:open', data: {} })).toBe(
      'ibgp:connect'
    )
  })

  it('should return ibgp:disconnect for internal:protocol:close', () => {
    expect(getRequiredPermission({ action: 'internal:protocol:close', data: {} })).toBe(
      'ibgp:disconnect'
    )
  })

  it('should return ibgp:connect for internal:protocol:connected', () => {
    expect(getRequiredPermission({ action: 'internal:protocol:connected', data: {} })).toBe(
      'ibgp:connect'
    )
  })

  it('should return ibgp:update for internal:protocol:update', () => {
    expect(getRequiredPermission({ action: 'internal:protocol:update', data: {} })).toBe(
      'ibgp:update'
    )
  })

  it('should return * for unknown action types', () => {
    const unknownAction = { action: 'unknown:action', data: {} } as Action
    expect(getRequiredPermission(unknownAction)).toBe('*')
  })
})

describe('hasPermission', () => {
  describe('admin role', () => {
    it('should grant any permission to admin role', () => {
      expect(hasPermission(['admin'], 'peer:create')).toBe(true)
      expect(hasPermission(['admin'], 'route:delete')).toBe(true)
      expect(hasPermission(['admin'], 'ibgp:connect')).toBe(true)
      expect(hasPermission(['admin'], '*')).toBe(true)
    })
  })

  describe('wildcard role', () => {
    it('should grant any permission to * role', () => {
      expect(hasPermission(['*'], 'peer:create')).toBe(true)
      expect(hasPermission(['*'], 'route:delete')).toBe(true)
    })
  })

  describe('direct permission', () => {
    it('should grant permission when role matches exactly', () => {
      expect(hasPermission(['peer:create'], 'peer:create')).toBe(true)
      expect(hasPermission(['route:delete'], 'route:delete')).toBe(true)
    })

    it('should deny permission when role does not match', () => {
      expect(hasPermission(['peer:create'], 'peer:delete')).toBe(false)
      expect(hasPermission(['route:create'], 'peer:create')).toBe(false)
    })
  })

  describe('category wildcard', () => {
    it('should grant permission when category wildcard matches', () => {
      expect(hasPermission(['peer:*'], 'peer:create')).toBe(true)
      expect(hasPermission(['peer:*'], 'peer:update')).toBe(true)
      expect(hasPermission(['peer:*'], 'peer:delete')).toBe(true)
    })

    it('should deny permission when category wildcard does not match', () => {
      expect(hasPermission(['peer:*'], 'route:create')).toBe(false)
      expect(hasPermission(['route:*'], 'peer:create')).toBe(false)
    })
  })

  describe('multiple roles', () => {
    it('should grant permission if any role matches', () => {
      expect(hasPermission(['viewer', 'peer:create'], 'peer:create')).toBe(true)
      expect(hasPermission(['peer:create', 'route:create'], 'route:create')).toBe(true)
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
