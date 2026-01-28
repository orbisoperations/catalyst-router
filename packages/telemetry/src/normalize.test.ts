import { describe, expect, it } from 'bun:test'
import { normalizePath } from './normalize'

describe('normalizePath', () => {
  describe('UUID normalization', () => {
    it('replaces a UUID segment with :uuid', () => {
      expect(normalizePath('/users/550e8400-e29b-41d4-a716-446655440000/orders')).toBe(
        '/users/:uuid/orders'
      )
    })

    it('replaces uppercase UUIDs', () => {
      expect(normalizePath('/items/550E8400-E29B-41D4-A716-446655440000')).toBe('/items/:uuid')
    })

    it('replaces multiple UUIDs in one path', () => {
      expect(
        normalizePath(
          '/orgs/550e8400-e29b-41d4-a716-446655440000/users/660e8400-e29b-41d4-a716-446655440001'
        )
      ).toBe('/orgs/:uuid/users/:uuid')
    })
  })

  describe('numeric ID normalization', () => {
    it('replaces a numeric segment with :id', () => {
      expect(normalizePath('/items/12345')).toBe('/items/:id')
    })

    it('replaces multiple numeric segments', () => {
      expect(normalizePath('/users/42/orders/99')).toBe('/users/:id/orders/:id')
    })

    it('does not replace non-numeric segments', () => {
      expect(normalizePath('/users/alice')).toBe('/users/alice')
    })
  })

  describe('passthrough', () => {
    it('preserves /health unchanged', () => {
      expect(normalizePath('/health')).toBe('/health')
    })

    it('preserves root path', () => {
      expect(normalizePath('/')).toBe('/')
    })

    it('preserves static paths', () => {
      expect(normalizePath('/api/v1/users')).toBe('/api/v1/users')
    })
  })

  describe('mixed patterns', () => {
    it('normalizes both UUID and numeric segments', () => {
      expect(normalizePath('/users/550e8400-e29b-41d4-a716-446655440000/orders/42')).toBe(
        '/users/:uuid/orders/:id'
      )
    })
  })

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(normalizePath('')).toBe('')
    })

    it('handles path without leading slash', () => {
      expect(normalizePath('users/123')).toBe('users/:id')
    })

    it('handles trailing slash', () => {
      expect(normalizePath('/users/123/')).toBe('/users/:id/')
    })
  })
})
