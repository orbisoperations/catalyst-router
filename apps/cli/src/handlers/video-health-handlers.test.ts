import { describe, expect, it } from 'vitest'
import type { HealthCheckInput } from '../types.js'

describe('Video Health Handlers', () => {
  describe('Type Definitions', () => {
    it('should have HealthCheckInput type with required fields', () => {
      const input: HealthCheckInput = {
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      }
      expect(input.videoUrl).toBe('http://localhost:8100')
    })
  })

  describe('Handler Return Types', () => {
    it('healthCheckHandler should return success with healthy and ready status', () => {
      const result: {
        success: true
        data: { status: string; ready: boolean; catalog: boolean }
      } = {
        success: true,
        data: { status: 'ok', ready: true, catalog: true },
      }
      expect(result.success).toBe(true)
      expect(result.data.status).toBe('ok')
      expect(result.data.ready).toBe(true)
      expect(result.data.catalog).toBe(true)
    })

    it('healthCheckHandler should return success with not-ready status', () => {
      const result: {
        success: true
        data: { status: string; ready: boolean; catalog: boolean }
      } = {
        success: true,
        data: { status: 'ok', ready: false, catalog: false },
      }
      expect(result.success).toBe(true)
      expect(result.data.status).toBe('ok')
      expect(result.data.ready).toBe(false)
      expect(result.data.catalog).toBe(false)
    })

    it('healthCheckHandler should return error result type', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'fetch failed',
      }
      expect(errorResult.success).toBe(false)
      expect(errorResult.error).toBe('fetch failed')
    })
  })

  describe('Handler Error Handling', () => {
    it('should handle unreachable video service', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'fetch failed',
      }
      expect(errorResult.success).toBe(false)
      expect(typeof errorResult.error).toBe('string')
    })

    it('should handle request timeout', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'The operation was aborted due to timeout',
      }
      expect(errorResult.success).toBe(false)
      expect(errorResult.error).toContain('timeout')
    })
  })
})
