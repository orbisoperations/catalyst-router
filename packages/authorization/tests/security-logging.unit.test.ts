import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Static analysis tests: verify that structured security & audit logging events
 * are present in the authorization source files.
 *
 * These tests scan source code for required event.name strings and their
 * associated structured properties to ensure security events are emitted
 * during key rotation, token lifecycle, and policy evaluation.
 */
describe('security & audit logging', () => {
  describe('persistent.ts — key rotation events', () => {
    const file = path.resolve(__dirname, '../src/key-manager/persistent.ts')
    const content = fs.readFileSync(file, 'utf-8')

    it('imports getLogger from @catalyst/telemetry', () => {
      expect(content).toContain("from '@catalyst/telemetry'")
      expect(content).toContain('getLogger')
    })

    it('emits auth.cert.rotation.started with key.old_id and key.new_id', () => {
      expect(content).toContain("'event.name': 'auth.cert.rotation.started'")
      const idx = content.indexOf("'event.name': 'auth.cert.rotation.started'")
      const blockStart = content.lastIndexOf('logger.', idx)
      const blockEnd = content.indexOf('})', idx)
      const block = content.slice(blockStart, blockEnd)
      expect(block).toContain("'key.old_id':")
      expect(block).toContain("'key.new_id':")
    })

    it('emits auth.cert.rotation.completed with key.old_id, key.new_id, and key.grace_period_ends_at', () => {
      expect(content).toContain("'event.name': 'auth.cert.rotation.completed'")
      const idx = content.indexOf("'event.name': 'auth.cert.rotation.completed'")
      const blockStart = content.lastIndexOf('logger.', idx)
      const blockEnd = content.indexOf('})', idx)
      const block = content.slice(blockStart, blockEnd)
      expect(block).toContain("'key.old_id':")
      expect(block).toContain("'key.new_id':")
      expect(block).toContain("'key.grace_period_ends_at':")
    })
  })

  describe('local/index.ts — token lifecycle events', () => {
    const file = path.resolve(__dirname, '../src/jwt/local/index.ts')
    const content = fs.readFileSync(file, 'utf-8')

    it('imports getLogger from @catalyst/telemetry', () => {
      expect(content).toContain("from '@catalyst/telemetry'")
      expect(content).toContain('getLogger')
    })

    it('emits auth.token.minted with token.jti, token.subject, and token.principal', () => {
      expect(content).toContain("'event.name': 'auth.token.minted'")
      const idx = content.indexOf("'event.name': 'auth.token.minted'")
      const blockStart = content.lastIndexOf('logger.', idx)
      const blockEnd = content.indexOf('})', idx)
      const block = content.slice(blockStart, blockEnd)
      expect(block).toContain("'token.jti':")
      expect(block).toContain("'token.subject':")
      expect(block).toContain("'token.principal':")
    })

    it('emits auth.token.revoked with revoke.method', () => {
      expect(content).toContain("'event.name': 'auth.token.revoked'")
      // There should be at least one revoke log with revoke.method
      const idx = content.indexOf("'event.name': 'auth.token.revoked'")
      const blockStart = content.lastIndexOf('logger.', idx)
      const blockEnd = content.indexOf('})', idx)
      const block = content.slice(blockStart, blockEnd)
      expect(block).toContain("'revoke.method':")
    })

    it('emits auth.token.rejected with token.jti and reason', () => {
      expect(content).toContain("'event.name': 'auth.token.rejected'")
      const idx = content.indexOf("'event.name': 'auth.token.rejected'")
      const blockStart = content.lastIndexOf('logger.', idx)
      const blockEnd = content.indexOf('})', idx)
      const block = content.slice(blockStart, blockEnd)
      expect(block).toContain("'token.jti':")
      expect(block).toContain('reason:')
    })
  })

  describe('rpc/server.ts — policy evaluation logging', () => {
    const file = path.resolve(__dirname, '../src/service/rpc/server.ts')
    const content = fs.readFileSync(file, 'utf-8')

    it('emits auth.policy.evaluated with auth.action and auth.allowed', () => {
      expect(content).toContain("'event.name': 'auth.policy.evaluated'")
      const idx = content.indexOf("'event.name': 'auth.policy.evaluated'")
      const blockStart = content.lastIndexOf('logger.', idx)
      const blockEnd = content.indexOf('})', idx)
      const block = content.slice(blockStart, blockEnd)
      expect(block).toContain("'auth.action':")
      expect(block).toContain("'auth.allowed':")
    })

    it('auth.policy.evaluated includes auth.decision and auth.reasons', () => {
      const idx = content.indexOf("'event.name': 'auth.policy.evaluated'")
      const blockStart = content.lastIndexOf('logger.', idx)
      const blockEnd = content.indexOf('})', idx)
      const block = content.slice(blockStart, blockEnd)
      expect(block).toContain("'auth.decision':")
      expect(block).toContain("'auth.reasons':")
    })
  })
})
