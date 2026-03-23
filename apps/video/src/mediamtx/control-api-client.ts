import type {
  MediaMtxPathInfo,
  MediaMtxPathsListResponse,
  MediaMtxRelayPathConfig,
} from './types.js'

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number }

export interface ControlApiClientOptions {
  /** Base URL for the MediaMTX Control API (e.g., "http://127.0.0.1:9997"). */
  baseUrl: string
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

  constructor(options: ControlApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
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
   * Remove a relay path when a remote route is withdrawn.
   * DELETE /v3/config/paths/delete/{name}
   */
  async deletePath(name: string): Promise<ApiResult<void>> {
    return this.del(`/v3/config/paths/delete/${encodeURIComponent(name)}`)
  }

  private async get<T>(path: string): Promise<ApiResult<T>> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`)
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}`, status: response.status }
      }
      const data = (await response.json()) as T
      return { ok: true, data }
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
      const response = await fetch(`${this.baseUrl}${path}`, { method: 'DELETE' })
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}`, status: response.status }
      }
      return { ok: true, data: undefined }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
