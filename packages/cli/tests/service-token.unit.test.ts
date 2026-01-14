import { describe, it, expect } from 'bun:test'
import { parseClaims } from '../src/commands/service-token.js'

describe('Service Token Commands', () => {
  describe('parseClaims', () => {
    it('should parse valid JSON claims', () => {
      const claims = '{"role":"admin","permissions":["read","write"]}'
      const result = parseClaims(claims)
      expect(result).toEqual({
        role: 'admin',
        permissions: ['read', 'write'],
      })
    })

    it('should return undefined for empty input', () => {
      expect(parseClaims(undefined)).toBeUndefined()
      expect(parseClaims('')).toBeUndefined()
    })

    it('should throw error for invalid JSON', () => {
      expect(() => parseClaims('{invalid json}')).toThrow('Invalid JSON for claims')
    })

    it('should throw error for non-object JSON', () => {
      expect(() => parseClaims('"string"')).toThrow('Claims must be a JSON object')
      expect(() => parseClaims('123')).toThrow('Claims must be a JSON object')
      expect(() => parseClaims('["array"]')).toThrow('Claims must be a JSON object')
      expect(() => parseClaims('null')).toThrow('Claims must be a JSON object')
    })

    it('should parse nested objects', () => {
      const claims = '{"user":{"id":"123","name":"test"},"metadata":{"version":1}}'
      const result = parseClaims(claims)
      expect(result).toEqual({
        user: { id: '123', name: 'test' },
        metadata: { version: 1 },
      })
    })
  })
})
