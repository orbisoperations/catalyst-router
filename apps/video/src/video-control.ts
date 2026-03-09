import { z } from 'zod'
import { Hono } from 'hono'
import { SpanStatusCode } from '@opentelemetry/api'
import type { Tracer } from '@opentelemetry/api'
import { Action as AuthAction } from '@catalyst/authorization'
import { getLogger } from '@catalyst/telemetry'
import type { StreamEntry } from './bus-client.js'

const logger = getLogger('video-control')

const MediaMTXWebhookPayloadSchema = z.object({
  path: z.string().min(1).max(253),
  sourceType: z.string().optional(),
  query: z.string().optional(),
})

type MediaMTXWebhookPayload = z.infer<typeof MediaMTXWebhookPayloadSchema>

class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

const CAMERA_SOURCE_TYPES = new Set([
  'rtspSource',
  'rtspsSource',
  'rtmpSource',
  'srtSource',
  'webrtcSession',
  'rpicamera',
])

function mapSourceType(
  mtxSourceType: string | undefined
): 'camera' | 'relay' | 'file' | 'synthetic' {
  if (!mtxSourceType) return 'synthetic'
  if (CAMERA_SOURCE_TYPES.has(mtxSourceType)) return 'camera'
  if (mtxSourceType === 'hlsSource') return 'relay'
  if (mtxSourceType === 'recordSource') return 'file'
  return 'synthetic'
}

// ---------------------------------------------------------------------------
// Stream catalog types (T034 adapted for video service)
// StreamEntry is imported from bus-client.ts (canonical source)
// ---------------------------------------------------------------------------

export type { StreamEntry } from './bus-client.js'

export interface CatalogQuery {
  sourceNode?: string
  protocol?: string
  scope?: 'all' | 'local' | 'remote'
}

const VALID_SCOPES = new Set(['all', 'local', 'remote'])

export function queryStreamCatalog(
  streams: StreamEntry[],
  query: CatalogQuery = {}
): StreamEntry[] {
  const { sourceNode, protocol } = query
  const scope = query.scope && VALID_SCOPES.has(query.scope) ? query.scope : 'all'

  return streams.filter((s) => {
    if (scope !== 'all' && s.source !== scope) return false
    if (protocol !== undefined && s.protocol !== protocol) return false
    if (sourceNode !== undefined && s.sourceNode !== sourceNode) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// Video action types
// ---------------------------------------------------------------------------

interface VideoAction {
  action: string
  data: {
    name: string
    protocol: string
    metadata?: Record<string, unknown>
  }
}

// ---------------------------------------------------------------------------
// Auth service interface
// ---------------------------------------------------------------------------

interface AuthService {
  evaluate(request: {
    token: string
    action: string
    nodeContext: { nodeId: string; domains: string[] }
  }): Promise<{ success: boolean; allowed?: boolean }>
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

interface VideoHooksDeps {
  dispatch: (action: VideoAction) => Promise<{ success: boolean }>
  getCatalog?: () => { streams: StreamEntry[] }
  nodeId: string
  domains?: string[]
  auth?: AuthService
  debounceMs?: number
  isReady?: () => boolean
  tracer?: Tracer
}

// ---------------------------------------------------------------------------
// createVideoHooks
// ---------------------------------------------------------------------------

export function createVideoHooks(deps: VideoHooksDeps) {
  const {
    dispatch,
    getCatalog,
    nodeId,
    domains = [],
    auth,
    debounceMs = 500,
    isReady,
    tracer,
  } = deps

  const trackedPaths = new Set<string>()
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingActions = new Map<
    string,
    { type: 'ready' | 'not-ready'; payload: MediaMTXWebhookPayload }
  >()

  async function onReady(payload: unknown) {
    const startTime = Date.now()
    const result = MediaMTXWebhookPayloadSchema.safeParse(payload)
    if (!result.success) {
      throw new ValidationError('Invalid webhook payload')
    }
    const parsed = result.data
    const sourceType = mapSourceType(parsed.sourceType)

    trackedPaths.add(parsed.path)

    logger.info`Stream ready: ${parsed.path} (sourceType=${sourceType})`

    const doDispatch = async () => {
      await dispatch({
        action: 'LocalRouteCreate',
        data: {
          name: parsed.path,
          protocol: 'media',
          metadata: {
            sourceNode: nodeId,
            sourceType,
          },
        },
      })
    }

    if (tracer) {
      await tracer.startActiveSpan(
        'video.webhook.dispatch',
        { attributes: { 'video.stream.path': parsed.path, 'video.webhook.type': 'ready' } },
        async (span) => {
          try {
            await doDispatch()
            span.end()
          } catch (err) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
            span.end()
            throw err
          }
        }
      )
    } else {
      await doDispatch()
    }

    logger.info`Publish dispatched for ${parsed.path} in ${Date.now() - startTime}ms`
  }

  async function onNotReady(payload: unknown) {
    const startTime = Date.now()
    const result = MediaMTXWebhookPayloadSchema.safeParse(payload)
    if (!result.success) {
      throw new ValidationError('Invalid webhook payload')
    }
    const parsed = result.data

    trackedPaths.delete(parsed.path)

    logger.info`Stream not ready: ${parsed.path}`

    const doDispatch = async () => {
      await dispatch({
        action: 'LocalRouteDelete',
        data: {
          name: parsed.path,
          protocol: 'media',
          metadata: {
            sourceNode: nodeId,
            sourceType: mapSourceType(parsed.sourceType),
          },
        },
      })
    }

    if (tracer) {
      await tracer.startActiveSpan(
        'video.webhook.dispatch',
        { attributes: { 'video.stream.path': parsed.path, 'video.webhook.type': 'not-ready' } },
        async (span) => {
          try {
            await doDispatch()
            span.end()
          } catch (err) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
            span.end()
            throw err
          }
        }
      )
    } else {
      await doDispatch()
    }

    logger.info`Unpublish dispatched for ${parsed.path} in ${Date.now() - startTime}ms`
  }

  async function reconcile(activePaths: string[]) {
    const activeSet = new Set(activePaths)
    const orphans = [...trackedPaths].filter((p) => !activeSet.has(p))

    for (const path of orphans) {
      trackedPaths.delete(path)
      logger.info`Reconcile: purging orphan stream ${path}`
      await dispatch({
        action: 'LocalRouteDelete',
        data: {
          name: path,
          protocol: 'media',
          metadata: { sourceNode: nodeId },
        },
      })
    }

    return orphans
  }

  function debouncedReady(payload: MediaMTXWebhookPayload): void {
    const parsed = MediaMTXWebhookPayloadSchema.parse(payload)
    const path = parsed.path

    const existing = debounceTimers.get(path)
    if (existing) clearTimeout(existing)

    pendingActions.set(path, { type: 'ready', payload })

    debounceTimers.set(
      path,
      setTimeout(() => {
        debounceTimers.delete(path)
        const pending = pendingActions.get(path)
        pendingActions.delete(path)
        if (pending?.type === 'ready') {
          onReady(pending.payload).catch((err) => {
            logger.error`Debounced dispatch failed for ${path}: ${err}`
          })
        }
      }, debounceMs)
    )
  }

  function debouncedNotReady(payload: MediaMTXWebhookPayload): void {
    const parsed = MediaMTXWebhookPayloadSchema.parse(payload)
    const path = parsed.path

    const existing = debounceTimers.get(path)
    if (existing) clearTimeout(existing)

    pendingActions.set(path, { type: 'not-ready', payload })

    debounceTimers.set(
      path,
      setTimeout(() => {
        debounceTimers.delete(path)
        const pending = pendingActions.get(path)
        pendingActions.delete(path)
        if (pending?.type === 'not-ready') {
          onNotReady(pending.payload).catch((err) => {
            logger.error`Debounced dispatch failed for ${path}: ${err}`
          })
        }
      }, debounceMs)
    )
  }

  const handler = new Hono()

  // T035: isReady gate - return 503 when service not ready
  function checkReady(): boolean {
    if (isReady !== undefined) return isReady()
    return getCatalog !== undefined
  }

  // T032: Use debouncedReady/debouncedNotReady in handlers (fire-and-forget)
  handler.post('/hooks/ready', async (c) => {
    if (!checkReady()) {
      return c.json({ error: 'Service not ready' }, 503)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid payload' }, 400)
    }
    try {
      debouncedReady(body as MediaMTXWebhookPayload)
    } catch (err) {
      if (err instanceof ValidationError || err instanceof z.ZodError) {
        return c.json({ error: 'Invalid payload' }, 400)
      }
      logger.error`Webhook ready handler failed: ${err}`
      return c.json({ error: 'Internal error' }, 500)
    }
    return c.json({ ok: true })
  })

  handler.post('/hooks/not-ready', async (c) => {
    if (!checkReady()) {
      return c.json({ error: 'Service not ready' }, 503)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid payload' }, 400)
    }
    try {
      debouncedNotReady(body as MediaMTXWebhookPayload)
    } catch (err) {
      if (err instanceof ValidationError || err instanceof z.ZodError) {
        return c.json({ error: 'Invalid payload' }, 400)
      }
      logger.error`Webhook not-ready handler failed: ${err}`
      return c.json({ error: 'Internal error' }, 500)
    }
    return c.json({ ok: true })
  })

  // T034: /streams uses getCatalog instead of getState
  // FR-010: Returns empty array (not error) when catalog not available
  handler.get('/streams', async (c) => {
    if (auth) {
      const authHeader = c.req.header('Authorization')
      if (!authHeader) {
        return c.json({ error: 'Authorization header required' }, 401)
      }
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
      try {
        const result = await auth.evaluate({
          token,
          action: AuthAction.STREAM_DISCOVER,
          nodeContext: { nodeId, domains },
        })
        if (!result.success || !result.allowed) {
          return c.json({ error: 'Forbidden' }, 403)
        }
      } catch {
        return c.json({ error: 'Forbidden' }, 403)
      }
    }

    const scope = c.req.query('scope')
    const sourceNode = c.req.query('sourceNode')
    const protocol = c.req.query('protocol')

    const validScopes = ['all', 'local', 'remote']
    const resolvedScope =
      scope && validScopes.includes(scope) ? (scope as CatalogQuery['scope']) : 'all'

    const catalog = getCatalog ? getCatalog() : { streams: [] }
    const streams = queryStreamCatalog(catalog.streams, {
      scope: resolvedScope,
      sourceNode: sourceNode || undefined,
      protocol: protocol || undefined,
    })
    return c.json({ streams })
  })

  function cleanup(): void {
    for (const timer of debounceTimers.values()) {
      clearTimeout(timer)
    }
    debounceTimers.clear()
    pendingActions.clear()
  }

  return {
    handler,
    onReady,
    onNotReady,
    reconcile,
    trackedPaths,
    debouncedReady,
    debouncedNotReady,
    cleanup,
  }
}
