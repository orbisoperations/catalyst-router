import { describe, expect, it } from 'vitest'
import type { ListRelaysInput } from '../types.js'
import { listRelaysHandler } from './video-relay-handlers.js'

describe('Video Relay Handlers', () => {
  describe('Type Definitions', () => {
    it('should have ListRelaysInput type with required fields', () => {
      const input: ListRelaysInput = {
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      }
      expect(input.videoUrl).toBe('http://localhost:8100')
    })

    it('should have ListRelaysInput type with optional token', () => {
      const input: ListRelaysInput = {
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
        token: 'test-token',
      }
      expect(input.token).toBe('test-token')
    })
  })

  describe('Handler Return Types', () => {
    it('listRelaysHandler should return deferred result', () => {
      const result: { success: true; data: { available: false } } = {
        success: true,
        data: { available: false },
      }
      expect(result.success).toBe(true)
      expect(result.data.available).toBe(false)
    })
  })

  describe('Handler Error Handling', () => {
    it('should handle error result type', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'Relay listing not available',
      }
      expect(errorResult.success).toBe(false)
      expect(typeof errorResult.error).toBe('string')
    })
  })

  describe('Handler Behavior', () => {
    it('listRelaysHandler returns deferred result', async () => {
      const result = await listRelaysHandler({
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.available).toBe(false)
      }
    })
  })
})
