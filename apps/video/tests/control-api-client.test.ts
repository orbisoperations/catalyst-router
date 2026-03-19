import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ControlApiClient } from '../src/mediamtx/control-api-client.js'

describe('ControlApiClient', () => {
  let client: ControlApiClient
  const baseUrl = 'http://127.0.0.1:9997'
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    client = new ControlApiClient({ baseUrl })
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  describe('listPaths', () => {
    it('returns path list on success', async () => {
      const response = { pageCount: 1, items: [{ name: 'cam-front', ready: true }] }
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }))

      const result = await client.listPaths()

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.items).toHaveLength(1)
        expect(result.data.items[0].name).toBe('cam-front')
      }
      expect(fetchSpy).toHaveBeenCalledWith(`${baseUrl}/v3/paths/list?page=0&itemsPerPage=1000`)
    })

    it('returns error on HTTP failure', async () => {
      fetchSpy.mockResolvedValue(new Response('', { status: 500 }))

      const result = await client.listPaths()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('HTTP 500')
        expect(result.status).toBe(500)
      }
    })

    it('returns error on network failure', async () => {
      fetchSpy.mockRejectedValue(new Error('Connection refused'))

      const result = await client.listPaths()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('Connection refused')
        expect(result.status).toBeUndefined()
      }
    })
  })

  describe('getPath', () => {
    it('returns path info on success', async () => {
      const pathInfo = {
        name: 'cam-front',
        confName: 'all_others',
        source: { type: 'rtspSession', id: 'abc' },
        ready: true,
        readyTime: '2026-03-15T00:00:00Z',
        tracks: ['H264', 'Opus'],
        bytesReceived: 1024,
        bytesSent: 512,
        readers: [],
      }
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(pathInfo), { status: 200 }))

      const result = await client.getPath('cam-front')

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.name).toBe('cam-front')
        expect(result.data.tracks).toEqual(['H264', 'Opus'])
      }
    })

    it('encodes path names in the URL', async () => {
      fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))

      await client.getPath('cam.front-1')

      expect(fetchSpy).toHaveBeenCalledWith(`${baseUrl}/v3/paths/get/cam.front-1`)
    })

    it('returns error result on malformed JSON response', async () => {
      fetchSpy.mockResolvedValue(new Response('not-json', { status: 200 }))

      const result = await client.getPath('cam-front')

      expect(result.ok).toBe(false)
    })

    it('returns error for non-existent path', async () => {
      fetchSpy.mockResolvedValue(new Response('', { status: 404 }))

      const result = await client.getPath('nonexistent')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(404)
      }
    })
  })

  describe('addPath', () => {
    it('creates relay path on success', async () => {
      fetchSpy.mockResolvedValue(new Response('', { status: 200 }))

      const result = await client.addPath('cam-front', {
        source: 'rtsp://10.0.1.5:8554/cam-front',
        sourceOnDemand: true,
        sourceOnDemandStartTimeout: '10s',
        sourceOnDemandCloseAfter: '10s',
      })

      expect(result.ok).toBe(true)

      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${baseUrl}/v3/config/paths/add/cam-front`)
      expect(options.method).toBe('POST')

      const body = JSON.parse(options.body as string)
      expect(body.source).toBe('rtsp://10.0.1.5:8554/cam-front')
      expect(body.sourceOnDemand).toBe(true)
    })

    it('passes relay auth credentials when provided', async () => {
      fetchSpy.mockResolvedValue(new Response('', { status: 200 }))

      await client.addPath('cam-front', {
        source: 'rtsp://10.0.1.5:8554/cam-front',
        sourceOnDemand: true,
        sourceUser: 'relay',
        sourcePass: 'jwt-token-here',
      })

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
      expect(body.sourceUser).toBe('relay')
      expect(body.sourcePass).toBe('jwt-token-here')
    })

    it('includes all timeout fields in request body', async () => {
      fetchSpy.mockResolvedValue(new Response('', { status: 200 }))

      await client.addPath('cam-front', {
        source: 'rtsp://10.0.1.5:8554/cam-front',
        sourceOnDemand: true,
        sourceOnDemandStartTimeout: '15s',
        sourceOnDemandCloseAfter: '30s',
      })

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
      expect(body.sourceOnDemandStartTimeout).toBe('15s')
      expect(body.sourceOnDemandCloseAfter).toBe('30s')
    })

    it('returns error on HTTP failure', async () => {
      fetchSpy.mockResolvedValue(new Response('', { status: 400 }))

      const result = await client.addPath('cam-front', {
        source: 'rtsp://10.0.1.5:8554/cam-front',
        sourceOnDemand: true,
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(400)
    })
  })

  describe('deletePath', () => {
    it('deletes path on success', async () => {
      fetchSpy.mockResolvedValue(new Response('', { status: 200 }))

      const result = await client.deletePath('cam-front')

      expect(result.ok).toBe(true)
      expect(fetchSpy).toHaveBeenCalledWith(`${baseUrl}/v3/config/paths/delete/cam-front`, {
        method: 'DELETE',
      })
    })

    it('returns error on HTTP failure', async () => {
      fetchSpy.mockResolvedValue(new Response('', { status: 404 }))

      const result = await client.deletePath('nonexistent')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(404)
    })

    it('returns error on network failure', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'))

      const result = await client.deletePath('cam-front')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('ECONNREFUSED')
    })
  })

  it('handles concurrent requests gracefully', async () => {
    const response = { pageCount: 1, items: [{ name: 'cam-1', ready: true }] }
    fetchSpy.mockImplementation(
      () => new Response(JSON.stringify(response), { status: 200 }) as any
    )

    const [r1, r2] = await Promise.all([client.listPaths(), client.listPaths()])

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('strips trailing slash from base URL', async () => {
    const clientSlash = new ControlApiClient({ baseUrl: 'http://127.0.0.1:9997/' })
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ pageCount: 0, items: [] }), { status: 200 })
    )

    await clientSlash.listPaths()

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:9997/v3/paths/list?page=0&itemsPerPage=1000'
    )
  })
})
