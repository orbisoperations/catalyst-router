import { resolveServiceUrl } from './resolve-url.js'

export interface StreamEntry {
  name: string
  protocol: string
  endpoint?: string
  source: 'local' | 'remote'
  sourceNode: string
  metadata?: Record<string, unknown>
  nodePath?: string[]
}

export interface PlaybackEndpoints {
  rtsp: string
  hls: string
  webrtc: string
  srt: string
}

export interface SubscribeResponse {
  success: true
  stream: {
    name: string
    protocol: string
    playbackEndpoints: PlaybackEndpoints
  }
}

export interface VideoServiceApi {
  listStreams(
    query?: { scope?: string; sourceNode?: string; protocol?: string },
    token?: string
  ): Promise<{ streams: StreamEntry[] }>
  subscribe(streamName: string, token: string): Promise<SubscribeResponse>
  health(): Promise<{ status: string }>
  ready(): Promise<{ ready: boolean; catalog: boolean }>
}

async function httpError(res: Response): Promise<Error> {
  try {
    const body = await res.json()
    const msg = body.error || body.message || `HTTP ${res.status}`
    return new Error(msg)
  } catch {
    return new Error(`HTTP ${res.status}`)
  }
}

export function createVideoClient(url?: string): VideoServiceApi {
  const baseUrl = resolveServiceUrl({
    url,
    envVar: 'CATALYST_VIDEO_URL',
    defaultPort: 8100,
    defaultPath: '',
    defaultProtocol: 'http',
  }).replace(/\/+$/, '')

  return {
    async listStreams(query, token) {
      const params = new URLSearchParams()
      if (query?.scope) params.set('scope', query.scope)
      if (query?.sourceNode) params.set('sourceNode', query.sourceNode)
      if (query?.protocol) params.set('protocol', query.protocol)
      const qs = params.toString()

      if (token) {
        const endpoint = `${baseUrl}/video-stream/streams${qs ? `?${qs}` : ''}`
        const res = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) throw await httpError(res)
        return res.json()
      }

      const endpoint = `${baseUrl}/streams${qs ? `?${qs}` : ''}`
      const res = await fetch(endpoint, {
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw await httpError(res)
      return res.json()
    },

    async subscribe(streamName, token) {
      const encoded = streamName.split('/').map(encodeURIComponent).join('/')
      const res = await fetch(`${baseUrl}/subscribe/${encoded}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw await httpError(res)
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Subscribe failed')
      return data
    },

    async health() {
      const res = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw await httpError(res)
      return res.json()
    },

    async ready() {
      const res = await fetch(`${baseUrl}/readyz`, {
        signal: AbortSignal.timeout(10000),
      })
      try {
        return await res.json()
      } catch {
        throw await httpError(res)
      }
    },
  }
}
