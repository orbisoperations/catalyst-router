import { describe, expect, it } from 'bun:test'
import { sanitizeAttributes } from './sanitizers'

describe('sanitizeAttributes', () => {
  describe('sensitive key redaction', () => {
    const sensitiveKeys = [
      'password',
      'token',
      'secret',
      'authorization',
      'cookie',
      'api_key',
      'api-key',
      'apikey',
      'bearer',
      'credential',
      'private_key',
      'private-key',
    ]

    for (const key of sensitiveKeys) {
      it(`redacts key containing "${key}"`, () => {
        const result = sanitizeAttributes({ [key]: 'sensitive-value' })
        expect(result[key]).toBe('[REDACTED]')
      })

      it(`redacts key containing "${key}" case-insensitively`, () => {
        const upperKey = `user.${key.toUpperCase()}`
        const result = sanitizeAttributes({ [upperKey]: 'sensitive-value' })
        expect(result[upperKey]).toBe('[REDACTED]')
      })
    }

    it('redacts compound keys like "auth.token.value"', () => {
      const result = sanitizeAttributes({ 'auth.token.value': 'abc123' })
      expect(result['auth.token.value']).toBe('[REDACTED]')
    })
  })

  describe('email scrubbing', () => {
    it('replaces email addresses with [EMAIL]', () => {
      const result = sanitizeAttributes({ 'user.email': 'alice@example.com' })
      expect(result['user.email']).toBe('[EMAIL]')
    })

    it('replaces emails with plus addressing', () => {
      const result = sanitizeAttributes({ contact: 'alice+tag@example.co.uk' })
      expect(result.contact).toBe('[EMAIL]')
    })

    it('does not replace non-email strings containing @', () => {
      const result = sanitizeAttributes({ mention: '@alice' })
      expect(result.mention).toBe('@alice')
    })

    it('replaces inline emails embedded in strings', () => {
      const result = sanitizeAttributes({
        message: 'User alice@example.com logged in from 10.0.0.1',
      })
      expect(result.message).toBe('User [EMAIL] logged in from 10.0.0.1')
    })

    it('replaces multiple inline emails in one string', () => {
      const result = sanitizeAttributes({
        log: 'From alice@a.com to bob@b.com',
      })
      expect(result.log).toBe('From [EMAIL] to [EMAIL]')
    })
  })

  describe('nested objects', () => {
    it('recursively sanitizes nested objects', () => {
      const result = sanitizeAttributes({
        request: {
          headers: { authorization: 'Bearer xxx' },
          user: 'alice@example.com',
        },
      })
      const nested = result.request as Record<string, unknown>
      const headers = nested.headers as Record<string, unknown>
      expect(headers.authorization).toBe('[REDACTED]')
      expect(nested.user).toBe('[EMAIL]')
    })

    it('handles deeply nested objects', () => {
      const result = sanitizeAttributes({
        a: { b: { c: { secret: 'deep' } } },
      })
      const a = result.a as Record<string, unknown>
      const b = a.b as Record<string, unknown>
      const c = b.c as Record<string, unknown>
      expect(c.secret).toBe('[REDACTED]')
    })
  })

  describe('arrays', () => {
    it('sanitizes email values in arrays', () => {
      const result = sanitizeAttributes({
        recipients: ['alice@example.com', 'bob@example.com'],
      })
      expect(result.recipients).toEqual(['[EMAIL]', '[EMAIL]'])
    })

    it('sanitizes mixed arrays', () => {
      const result = sanitizeAttributes({
        items: ['alice@example.com', 42, true, 'plain text'],
      })
      expect(result.items).toEqual(['[EMAIL]', 42, true, 'plain text'])
    })

    it('sanitizes nested objects inside arrays', () => {
      const result = sanitizeAttributes({
        users: [{ password: 'secret' }, { name: 'bob' }],
      })
      const users = result.users as Record<string, unknown>[]
      expect(users[0].password).toBe('[REDACTED]')
      expect(users[1].name).toBe('bob')
    })
  })

  describe('non-sensitive passthrough', () => {
    it('preserves non-sensitive string values', () => {
      const result = sanitizeAttributes({ 'http.method': 'GET', 'http.route': '/users' })
      expect(result['http.method']).toBe('GET')
      expect(result['http.route']).toBe('/users')
    })

    it('preserves numeric values', () => {
      const result = sanitizeAttributes({ 'http.status_code': 200 })
      expect(result['http.status_code']).toBe(200)
    })

    it('preserves boolean values', () => {
      const result = sanitizeAttributes({ 'cache.hit': true })
      expect(result['cache.hit']).toBe(true)
    })

    it('passes through null and undefined', () => {
      const result = sanitizeAttributes({ a: null, b: undefined })
      expect(result.a).toBeNull()
      expect(result.b).toBeUndefined()
    })
  })

  describe('immutability', () => {
    it('returns a new object', () => {
      const input = { key: 'value' }
      const result = sanitizeAttributes(input)
      expect(result).not.toBe(input)
    })

    it('does not modify the input object', () => {
      const input = { password: 'secret', name: 'alice' }
      sanitizeAttributes(input)
      expect(input.password).toBe('secret')
      expect(input.name).toBe('alice')
    })

    it('does not modify nested input objects', () => {
      const inner = { authorization: 'Bearer xxx' }
      const input = { headers: inner }
      sanitizeAttributes(input)
      expect(inner.authorization).toBe('Bearer xxx')
    })
  })

  describe('edge cases', () => {
    it('handles empty input', () => {
      const result = sanitizeAttributes({})
      expect(result).toEqual({})
    })

    it('handles input with no sensitive keys', () => {
      const input = { method: 'GET', path: '/health' }
      const result = sanitizeAttributes(input)
      expect(result).toEqual(input)
    })

    it('prioritizes key redaction over email scrubbing', () => {
      // If the key is "password" and value is an email, redact wins
      const result = sanitizeAttributes({ password: 'admin@example.com' })
      expect(result.password).toBe('[REDACTED]')
    })
  })
})
