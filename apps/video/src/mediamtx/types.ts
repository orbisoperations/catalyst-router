import { z } from 'zod'

/**
 * MediaMTX auth hook request payload.
 *
 * MediaMTX POSTs this JSON to the auth endpoint for every publish/read/playback
 * connection attempt. The `action` field determines the auth logic path.
 */
export const MediaMtxAuthRequestSchema = z.object({
  user: z.string().optional(),
  password: z.string().optional(),
  token: z.string().optional(),
  ip: z.string(),
  action: z.enum(['publish', 'read', 'playback']),
  path: z.string(),
  protocol: z.enum(['rtsp', 'rtmp', 'hls']),
  id: z.string(),
  query: z.string().optional(),
})

export type MediaMtxAuthRequest = z.infer<typeof MediaMtxAuthRequestSchema>

/**
 * MediaMTX lifecycle hook payload (ready / not-ready).
 *
 * Sent via curl from MediaMTX's runOnReady/runOnNotReady shell commands.
 * Path MUST match the same regex as MediaMTX pathRegexp to prevent injection.
 */
export const MediaMtxHookPayloadSchema = z.object({
  path: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  sourceType: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  sourceId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
})

export type MediaMtxHookPayload = z.infer<typeof MediaMtxHookPayloadSchema>

/**
 * MediaMTX path info from Control API responses.
 *
 * Subset of fields from GET /v3/paths/get/{name} and GET /v3/paths/list items.
 */
export interface MediaMtxPathInfo {
  name: string
  confName: string
  source: {
    type: string
    id: string
  } | null
  ready: boolean
  readyTime: string | null
  tracks: string[]
  bytesReceived: number
  bytesSent: number
  readers: Array<{ id: string }>
}

/**
 * MediaMTX paths list response from GET /v3/paths/list.
 */
export interface MediaMtxPathsListResponse {
  pageCount: number
  items: MediaMtxPathInfo[]
}

/**
 * MediaMTX unread hook payload (runOnUnread).
 *
 * Sent via curl from MediaMTX's runOnUnread shell command when a subscriber
 * disconnects. Used to deregister the session from the SessionRegistry.
 */
export const MediaMtxUnreadHookPayloadSchema = z.object({
  path: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  readerId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  readerType: z.string().regex(/^[a-zA-Z0-9._-]+$/),
})

export type MediaMtxUnreadHookPayload = z.infer<typeof MediaMtxUnreadHookPayloadSchema>

/**
 * MediaMTX session/connection item from list API responses.
 *
 * RTSP sessions (GET /v3/rtspsessions/list) and RTMP connections
 * (GET /v3/rtmpconns/list) include an `id` field. HLS muxers
 * (GET /v3/hlsmuxers/list) only have `path` — no per-session id.
 */
export interface MediaMtxSessionItem {
  id?: string
  state?: string
  path: string
}

/**
 * Paginated session list response from MediaMTX session/connection/muxer APIs.
 */
export interface MediaMtxSessionsListResponse {
  pageCount: number
  itemCount: number
  items: MediaMtxSessionItem[]
}

/**
 * Relay path creation request body for POST /v3/config/paths/add/{name}.
 */
export interface MediaMtxRelayPathConfig {
  source: string
  sourceOnDemand: boolean
  sourceOnDemandStartTimeout?: string
  sourceOnDemandCloseAfter?: string
  sourceUser?: string
  sourcePass?: string
}
