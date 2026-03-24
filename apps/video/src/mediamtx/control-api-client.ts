import { getLogger } from '@catalyst/telemetry'
import type {
  MediaMtxPathInfo,
  MediaMtxPathsListResponse,
  MediaMtxRelayPathConfig,
  MediaMtxSessionsListResponse,
} from './types.js'

const logger = getLogger(['catalyst', 'video', 'mediamtx'])

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number }

export interface ControlApiClientOptions {
  /** Base URL for the MediaMTX Control API (e.g., "http://127.0.0.1:9997"). */
  baseUrl: string
  /** Timeout for HTTP requests in ms (default: 5000). */
  timeoutMs?: number
}

/**
 * REST client for the MediaMTX Control API (/v3/*).
 *
 * Uses discriminated union results instead of exceptions — callers inspect
 * `result.ok` to determine success or failure. This aligns with the project's
 * discriminated union convention (Constitution XII).
 */
export class ControlApiClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(options: ControlApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? 5_000
  }

  /**
   * List all active paths. Used for reconciliation on reconnect.
   * GET /v3/paths/list?page=0&itemsPerPage=1000
   */
  async listPaths(): Promise<ApiResult<MediaMtxPathsListResponse>> {
    return this.get<MediaMtxPathsListResponse>('/v3/paths/list?page=0&itemsPerPage=1000')
  }

  /**
   * Get details for a single path including track metadata.
   * GET /v3/paths/get/{name}
   */
  async getPath(name: string): Promise<ApiResult<MediaMtxPathInfo>> {
    return this.get<MediaMtxPathInfo>(`/v3/paths/get/${encodeURIComponent(name)}`)
  }

  /**
   * Create an on-demand relay path for a remote stream.
   * POST /v3/config/paths/add/{name}
   */
  async addPath(name: string, config: MediaMtxRelayPathConfig): Promise<ApiResult<void>> {
    return this.post(`/v3/config/paths/add/${encodeURIComponent(name)}`, config)
  }

  /**
   * Update an existing relay path configuration.
   * PATCH /v3/config/paths/patch/{name}
   */
  async patchPath(
    name: string,
    config: Partial<MediaMtxRelayPathConfig>
  ): Promise<ApiResult<void>> {
    return this.patch(`/v3/config/paths/patch/${encodeURIComponent(name)}`, config)
  }

  /**
   * Remove a relay path when a remote route is withdrawn.
   * DELETE /v3/config/paths/delete/{name}
   */
  async deletePath(name: string): Promise<ApiResult<void>> {
    return this.del(`/v3/config/paths/delete/${encodeURIComponent(name)}`)
  }

  // ── Session kick APIs ──────────────────────────────────────────────

  /**
   * Kick a specific RTSP session by ID.
   * POST /v3/rtspsessions/kick/{id}
   */
  async kickRtspSession(id: string): Promise<ApiResult<void>> {
    return this.postEmpty(`/v3/rtspsessions/kick/${encodeURIComponent(id)}`)
  }

  /**
   * Kick a specific RTMP connection by ID.
   * POST /v3/rtmpconns/kick/{id}
   */
  async kickRtmpConn(id: string): Promise<ApiResult<void>> {
    return this.postEmpty(`/v3/rtmpconns/kick/${encodeURIComponent(id)}`)
  }

  /**
   * Kick a session by protocol. Dispatches to the correct per-protocol method.
   * HLS is a no-op — MediaMTX re-authenticates HLS on every segment request.
   */
  async kickSession(id: string, protocol: 'rtsp' | 'rtmp' | 'hls'): Promise<ApiResult<void>> {
    switch (protocol) {
      case 'rtsp':
        return this.kickRtspSession(id)
      case 'rtmp':
        return this.kickRtmpConn(id)
      case 'hls':
        logger.debug('HLS session kick is a no-op (auth hook re-validates per segment)', {
          'event.name': 'video.session.hls_kick_noop',
          id,
        })
        return { ok: true, data: undefined }
    }
  }

  // ── Session list APIs (for reconciliation) ─────────────────────────

  /** GET /v3/rtspsessions/list */
  async listRtspSessions(): Promise<ApiResult<MediaMtxSessionsListResponse>> {
    return this.get<MediaMtxSessionsListResponse>('/v3/rtspsessions/list?page=0&itemsPerPage=1000')
  }

  /** GET /v3/rtmpconns/list */
  async listRtmpConns(): Promise<ApiResult<MediaMtxSessionsListResponse>> {
    return this.get<MediaMtxSessionsListResponse>('/v3/rtmpconns/list?page=0&itemsPerPage=1000')
  }

  /** GET /v3/hlsmuxers/list */
  async listHlsMuxers(): Promise<ApiResult<MediaMtxSessionsListResponse>> {
    return this.get<MediaMtxSessionsListResponse>('/v3/hlsmuxers/list?page=0&itemsPerPage=1000')
  }

  private async get<T>(path: string): Promise<ApiResult<T>> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}`, status: response.status }
      }
      const data = (await response.json()) as T
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async postEmpty(path: string): Promise<ApiResult<void>> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}`, status: response.status }
      }
      return { ok: true, data: undefined }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async post(path: string, body: unknown): Promise<ApiResult<void>> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}`, status: response.status }
      }
      return { ok: true, data: undefined }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async patch(path: string, body: unknown): Promise<ApiResult<void>> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}`, status: response.status }
      }
      return { ok: true, data: undefined }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async del(path: string): Promise<ApiResult<void>> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}`, status: response.status }
      }
      return { ok: true, data: undefined }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
