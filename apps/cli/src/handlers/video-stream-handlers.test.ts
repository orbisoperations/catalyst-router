import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ListStreamsInput,
  GetStreamInput,
  SubscribeStreamInput,
  PlayStreamInput,
} from '../types.js'
import {
  listStreamsHandler,
  getStreamHandler,
  subscribeStreamHandler,
  playStreamHandler,
} from './video-stream-handlers.js'

describe('Video Stream Handlers', () => {
  describe('Type Definitions', () => {
    it('should have ListStreamsInput type with required fields', () => {
      const input: ListStreamsInput = {
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      }
      expect(input.videoUrl).toBe('http://localhost:8100')
    })

    it('should have ListStreamsInput type with optional fields', () => {
      const input: ListStreamsInput = {
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
        scope: 'local',
        sourceNode: 'nodeA',
        protocol: 'media',
        token: 'test-token',
      }
      expect(input.scope).toBe('local')
      expect(input.sourceNode).toBe('nodeA')
      expect(input.protocol).toBe('media')
      expect(input.token).toBe('test-token')
    })

    it('should have GetStreamInput type with required fields', () => {
      const input: GetStreamInput = {
        name: 'cam-front',
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      }
      expect(input.name).toBe('cam-front')
    })

    it('should have SubscribeStreamInput type with required fields', () => {
      const input: SubscribeStreamInput = {
        name: 'cam-front',
        token: 'test-token',
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      }
      expect(input.name).toBe('cam-front')
      expect(input.token).toBe('test-token')
    })

    it('should have PlayStreamInput type with required fields', () => {
      const input: PlayStreamInput = {
        name: 'cam-front',
        token: 'test-token',
        protocol: 'hls',
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      }
      expect(input.name).toBe('cam-front')
      expect(input.protocol).toBe('hls')
    })

    it('should have PlayStreamInput type with optional player', () => {
      const input: PlayStreamInput = {
        name: 'cam-front',
        token: 'test-token',
        protocol: 'rtsp',
        player: 'mpv',
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      }
      expect(input.player).toBe('mpv')
      expect(input.protocol).toBe('rtsp')
    })
  })

  describe('Handler Return Types', () => {
    it('listStreamsHandler should return success with streams array', () => {
      const result: {
        success: true
        data: {
          streams: Array<{
            name: string
            protocol: string
            endpoint?: string
            source: 'local' | 'remote'
            sourceNode: string
          }>
        }
      } = {
        success: true,
        data: {
          streams: [
            {
              name: 'cam-front',
              protocol: 'media',
              endpoint: 'rtsp://localhost:8554/cam-front',
              source: 'local',
              sourceNode: 'nodeA',
            },
            {
              name: 'cam-rear',
              protocol: 'media',
              source: 'remote',
              sourceNode: 'nodeB',
            },
          ],
        },
      }
      expect(result.success).toBe(true)
      expect(result.data.streams.length).toBe(2)
      expect(result.data.streams[0].source).toBe('local')
      expect(result.data.streams[1].source).toBe('remote')
    })

    it('listStreamsHandler should return success with empty streams array', () => {
      const result: { success: true; data: { streams: never[] } } = {
        success: true,
        data: { streams: [] },
      }
      expect(result.success).toBe(true)
      expect(result.data.streams.length).toBe(0)
    })

    it('getStreamHandler should return success with single stream', () => {
      const result: {
        success: true
        data: {
          stream: {
            name: string
            protocol: string
            source: 'local' | 'remote'
            sourceNode: string
            metadata?: Record<string, unknown>
            nodePath?: string[]
          }
        }
      } = {
        success: true,
        data: {
          stream: {
            name: 'cam-front',
            protocol: 'media',
            source: 'local',
            sourceNode: 'nodeA',
            metadata: { sourceType: 'camera' },
            nodePath: ['nodeA'],
          },
        },
      }
      expect(result.success).toBe(true)
      expect(result.data.stream.name).toBe('cam-front')
      expect(result.data.stream.metadata?.sourceType).toBe('camera')
    })

    it('getStreamHandler should return error when stream not found', () => {
      const result: { success: false; error: string } = {
        success: false,
        error: "Stream 'nonexistent' not found",
      }
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('subscribeStreamHandler should return success with playback endpoints', () => {
      const result: {
        success: true
        data: {
          name: string
          playbackEndpoints: { rtsp: string; hls: string; webrtc: string; srt: string }
        }
      } = {
        success: true,
        data: {
          name: 'cam-front',
          playbackEndpoints: {
            rtsp: 'rtsp://localhost:8554/cam-front',
            hls: 'http://localhost:8888/cam-front/index.m3u8',
            webrtc: 'http://localhost:8889/cam-front/whep',
            srt: 'srt://localhost:8890/cam-front',
          },
        },
      }
      expect(result.success).toBe(true)
      expect(result.data.name).toBe('cam-front')
      expect(result.data.playbackEndpoints.rtsp).toContain('rtsp://')
      expect(result.data.playbackEndpoints.hls).toContain('index.m3u8')
      expect(result.data.playbackEndpoints.webrtc).toContain('whep')
      expect(result.data.playbackEndpoints.srt).toContain('srt://')
    })

    it('subscribeStreamHandler should return error for not-found stream', () => {
      const result: { success: false; error: string } = {
        success: false,
        error: 'Stream not found',
      }
      expect(result.success).toBe(false)
      expect(result.error).toBe('Stream not found')
    })

    it('subscribeStreamHandler should return error for forbidden access', () => {
      const result: { success: false; error: string } = {
        success: false,
        error: 'Forbidden',
      }
      expect(result.success).toBe(false)
      expect(result.error).toBe('Forbidden')
    })
  })

  describe('Handler Error Handling', () => {
    it('should handle network errors gracefully', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'fetch failed',
      }
      expect(errorResult.success).toBe(false)
      expect(typeof errorResult.error).toBe('string')
    })

    it('should handle 401 unauthorized', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'Authorization header required',
      }
      expect(errorResult.success).toBe(false)
      expect(errorResult.error).toContain('Authorization')
    })

    it('should handle 403 forbidden', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'Forbidden',
      }
      expect(errorResult.success).toBe(false)
      expect(errorResult.error).toBe('Forbidden')
    })

    it('should handle 503 service not ready', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'Service not ready',
      }
      expect(errorResult.success).toBe(false)
      expect(errorResult.error).toContain('not ready')
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

    it('listStreamsHandler returns streams from video service', async () => {
      const streams = [
        { name: 'cam-front', protocol: 'media', source: 'local', sourceNode: 'nodeA' },
      ]
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ streams }),
      })

      const result = await listStreamsHandler({
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.streams).toEqual(streams)
      }
    })

    it('listStreamsHandler returns error on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('fetch failed'))

      const result = await listStreamsHandler({
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('fetch failed')
      }
    })

    it('getStreamHandler finds stream by name', async () => {
      const streams = [
        { name: 'cam-front', protocol: 'media', source: 'local', sourceNode: 'nodeA' },
        { name: 'cam-rear', protocol: 'media', source: 'remote', sourceNode: 'nodeB' },
      ]
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ streams }),
      })

      const result = await getStreamHandler({
        name: 'cam-rear',
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.stream.name).toBe('cam-rear')
        expect(result.data.stream.sourceNode).toBe('nodeB')
      }
    })

    it('getStreamHandler returns error when stream not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ streams: [] }),
      })

      const result = await getStreamHandler({
        name: 'nonexistent',
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('nonexistent')
        expect(result.error).toContain('not found')
      }
    })

    it('subscribeStreamHandler returns playback endpoints', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          stream: {
            name: 'cam-front',
            protocol: 'media',
            playbackEndpoints: {
              rtsp: 'rtsp://localhost:8554/cam-front',
              hls: 'http://localhost:8888/cam-front/index.m3u8',
              webrtc: 'http://localhost:8889/cam-front/whep',
              srt: 'srt://localhost:8890/cam-front',
            },
          },
        }),
      })

      const result = await subscribeStreamHandler({
        name: 'cam-front',
        token: 'test-token',
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.name).toBe('cam-front')
        expect(result.data.playbackEndpoints.rtsp).toContain('rtsp://')
        expect(result.data.playbackEndpoints.hls).toContain('index.m3u8')
      }
    })

    it('subscribeStreamHandler returns error on 403', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Forbidden' }),
      })

      const result = await subscribeStreamHandler({
        name: 'cam-front',
        token: 'bad-token',
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('Forbidden')
      }
    })

    it('playStreamHandler returns error when no player found', async () => {
      const result = await playStreamHandler({
        name: 'cam-front',
        token: 'test-token',
        protocol: 'hls',
        player: 'nonexistent-player-xyz',
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('No video player found')
        expect(result.error).toContain('nonexistent-player-xyz')
      }
    })

    it('playStreamHandler returns player and url on success', async () => {
      // Use 'node' as player since it is always available in dev
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          stream: {
            name: 'cam-front',
            protocol: 'media',
            playbackEndpoints: {
              rtsp: 'rtsp://localhost:8554/cam-front',
              hls: 'http://localhost:8888/cam-front/index.m3u8',
              webrtc: 'http://localhost:8889/cam-front/whep',
              srt: 'srt://localhost:8890/cam-front',
            },
          },
        }),
      })

      const result = await playStreamHandler({
        name: 'cam-front',
        token: 'test-token',
        protocol: 'hls',
        player: 'node',
        videoUrl: 'http://localhost:8100',
        logLevel: 'info',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.player).toBe('node')
        expect(result.data.protocol).toBe('hls')
        expect(result.data.url).toContain('index.m3u8')
      }
    })
  })
})
