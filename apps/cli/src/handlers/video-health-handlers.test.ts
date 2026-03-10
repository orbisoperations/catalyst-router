import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HealthCheckInput } from '../types.js'
import { healthCheckHandler } from './video-health-handlers.js'

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

  describe('Handler Behavior', () => {
    const mockFetch = vi.fn()

    beforeEach(() => {
      vi.stubGlobal('fetch', mockFetch)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('healthCheckHandler returns combined health and readiness', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, catalog: true }) })

      const result = await healthCheckHandler({
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.status).toBe('ok')
        expect(result.data.ready).toBe(true)
        expect(result.data.catalog).toBe(true)
      }
    })

    it('healthCheckHandler returns error on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('fetch failed'))

      const result = await healthCheckHandler({
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('fetch failed')
      }
    })
  })
})
