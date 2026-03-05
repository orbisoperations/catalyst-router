import { describe, it, expect, beforeEach } from 'vitest'
import { VideoRpcServer } from '../src/rpc/server.js'
import { StreamState } from '../src/state/stream-state.js'

describe('VideoRpcServer', () => {
  let streamState: StreamState
  let rpcServer: VideoRpcServer

  beforeEach(() => {
    streamState = new StreamState()
    rpcServer = new VideoRpcServer(async (config) => {
      streamState.setRemote(config.routes)
      return { success: true }
    }, streamState)
  })

  describe('updateMediaRoutes', () => {
    it('accepts valid media route config', async () => {
      const result = await rpcServer.updateMediaRoutes({
        routes: [
          {
            name: 'node-a/cam-front',
            endpoint: 'rtsp://node-a:8554/node-a/cam-front',
            protocol: 'media',
            tags: ['codec:h264'],
          },
        ],
      })
      expect(result).toEqual({ success: true })
    })

    it('rejects malformed config', async () => {
      const result = await rpcServer.updateMediaRoutes({ routes: 'invalid' })
      expect(result).toEqual({ success: false, error: 'Malformed video stream config' })
    })

    it('rejects missing routes field', async () => {
      const result = await rpcServer.updateMediaRoutes({})
      expect(result).toEqual({ success: false, error: 'Malformed video stream config' })
    })

    it('rejects route with invalid protocol', async () => {
      const result = await rpcServer.updateMediaRoutes({
        routes: [
          {
            name: 'test/cam',
            endpoint: 'rtsp://localhost:8554/test',
            protocol: 'http',
          },
        ],
      })
      expect(result).toEqual({ success: false, error: 'Malformed video stream config' })
    })

    it('accepts empty routes array', async () => {
      const result = await rpcServer.updateMediaRoutes({ routes: [] })
      expect(result).toEqual({ success: true })
    })
  })

  describe('getStreams', () => {
    it('returns empty streams when none exist', async () => {
      const result = await rpcServer.getStreams()
      expect(result).toEqual({ streams: [] })
    })

    it('returns local and remote streams', async () => {
      streamState.addLocal('node-b/cam-rear', 'rtsp://localhost:8554/node-b/cam-rear', [
        'codec:h265',
      ])
      streamState.setRemote([
        {
          name: 'node-a/cam-front',
          endpoint: 'rtsp://node-a:8554/node-a/cam-front',
          protocol: 'media',
          tags: ['codec:h264'],
        },
      ])

      const result = await rpcServer.getStreams()
      expect(result.streams).toHaveLength(2)
      expect(result.streams.find((s) => s.source === 'local')?.name).toBe('node-b/cam-rear')
      expect(result.streams.find((s) => s.source === 'remote')?.name).toBe('node-a/cam-front')
    })
  })
})
