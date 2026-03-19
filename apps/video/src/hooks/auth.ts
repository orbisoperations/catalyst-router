import { Hono } from 'hono'
import { getLogger } from '@catalyst/telemetry'
import type { MediaMtxAuthRequest } from '../mediamtx/types.js'
import { MediaMtxAuthRequestSchema } from '../mediamtx/types.js'

const logger = getLogger(['catalyst', 'video', 'auth'])

/**
 * JWT validation function — injected so the hook is auth-provider agnostic.
 * Returns the decoded payload on success, or an error string on failure.
 */
export interface TokenValidator {
  validate(
    token: string
  ): Promise<{ valid: true; payload: Record<string, unknown> } | { valid: false; error: string }>
}

/**
 * Cedar policy evaluator — injected so the hook can run STREAM_VIEW checks
 * without importing the full authorization engine.
 */
export interface StreamAccessEvaluator {
  evaluate(
    payload: Record<string, unknown>,
    resource: { nodeId: string; domainId: string }
  ): 'allow' | 'deny'
}

export interface AuthMetrics {
  authRequests: { add(value: number, attributes?: Record<string, string>): void }
  authFailures: { add(value: number, attributes?: Record<string, string>): void }
  authDuration: { record(value: number, attributes?: Record<string, string>): void }
}

export interface AuthHookOptions {
  tokenValidator: TokenValidator
  streamAccess: StreamAccessEvaluator
  nodeId: string
  domainId: string
  metrics?: AuthMetrics
}

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Shell-injection defense: $MTX_PATH is interpolated into runOnReady curl
 * commands. Only allow safe characters in stream path names.
 * Moved here from pathRegexp (which MediaMTX v1.16.0 doesn't support).
 */
const SAFE_PATH_RE = /^[a-zA-Z0-9._-]+$/

/**
 * MediaMTX external HTTP auth endpoint.
 *
 * Publish: localhost-only (no CAMERA entity in Cedar — cameras are
 * local hardware, so network identity is sufficient).
 *
 * Read/Playback: JWT validation + Cedar STREAM_VIEW evaluation.
 * JWT is extracted from the `token` field. For RTSP relay reads,
 * the JWT may be in the `password` field because RTSP has no
 * Bearer header — the relay manager tunnels it via sourcePass.
 */
export function createAuthHook(options: AuthHookOptions): Hono {
  const { tokenValidator, streamAccess, nodeId, domainId, metrics } = options
  const app = new Hono()

  app.post('/video-stream/auth', async (c) => {
    const start = performance.now()
    const body = await c.req.json().catch(() => null)
    const parsed = MediaMtxAuthRequestSchema.safeParse(body)

    if (!parsed.success) {
      logger.warn('Invalid hook payload rejected', {
        'event.name': 'video.auth.invalid_payload',
        error: parsed.error.message,
      })
      return c.json({ error: 'invalid_request', reason: 'Malformed auth payload' }, 400)
    }

    const req: MediaMtxAuthRequest = parsed.data

    // Reject paths with shell metacharacters (defense-in-depth for $MTX_PATH interpolation)
    if (req.path && !SAFE_PATH_RE.test(req.path)) {
      return c.json({ error: 'invalid_request', reason: 'Path contains unsafe characters' }, 400)
    }

    metrics?.authRequests.add(1, { action: req.action })

    if (req.action === 'publish') {
      const res = handlePublish(c, req)
      metrics?.authDuration.record((performance.now() - start) / 1000, { action: 'publish' })
      return res
    }

    // read or playback
    const res = await handleRead(c, req)
    metrics?.authDuration.record((performance.now() - start) / 1000, { action: req.action })
    return res
  })

  function handlePublish(
    c: { json: (body: unknown, status?: number) => Response },
    req: MediaMtxAuthRequest
  ) {
    if (LOCALHOST_IPS.has(req.ip)) {
      logger.debug('Auth allowed: {action} on {streamPath}', {
        'event.name': 'video.auth.allowed',
        action: req.action,
        streamPath: req.path,
        protocol: req.protocol,
        ip: req.ip,
      })
      return c.json({}, 200)
    }

    metrics?.authFailures.add(1, { action: 'publish', reason: 'remote_publish' })
    logger.warn('Remote publish denied from {ip} on {streamPath}', {
      'event.name': 'video.auth.remote_publish_denied',
      ip: req.ip,
      streamPath: req.path,
    })
    return c.json({ error: 'permission_denied', reason: 'Remote publish not allowed' }, 403)
  }

  async function handleRead(
    c: { json: (body: unknown, status?: number) => Response },
    req: MediaMtxAuthRequest
  ) {
    // Extract JWT: prefer `token` field, fall back to `password` for relay reads
    const jwt = req.token || req.password
    if (!jwt) {
      metrics?.authFailures.add(1, { action: req.action, reason: 'no_token' })
      logger.warn('Auth denied: {action} on {streamPath} from {ip}', {
        'event.name': 'video.auth.denied',
        action: req.action,
        streamPath: req.path,
        protocol: req.protocol,
        ip: req.ip,
        reason: 'no_token',
      })
      return c.json({ error: 'unauthorized', reason: 'No token provided' }, 401)
    }

    let result: Awaited<ReturnType<TokenValidator['validate']>>
    try {
      result = await tokenValidator.validate(jwt)
    } catch {
      metrics?.authFailures.add(1, { action: req.action, reason: 'auth_unreachable' })
      logger.error('Auth evaluation failed for {action} on {streamPath}: {error}', {
        'event.name': 'video.auth.error',
        action: req.action,
        streamPath: req.path,
        error: 'Authorization service unreachable',
      })
      return c.json({ error: 'system_error', reason: 'Authorization service unreachable' }, 503)
    }

    if (!result.valid) {
      metrics?.authFailures.add(1, { action: req.action, reason: 'invalid_token' })
      logger.warn('Auth denied: {action} on {streamPath} from {ip}', {
        'event.name': 'video.auth.denied',
        action: req.action,
        streamPath: req.path,
        protocol: req.protocol,
        ip: req.ip,
        reason: result.error,
      })
      return c.json({ error: 'unauthorized', reason: result.error }, 401)
    }

    const decision = streamAccess.evaluate(result.payload, { nodeId, domainId })
    if (decision === 'deny') {
      metrics?.authFailures.add(1, { action: req.action, reason: 'cedar_deny' })
      logger.warn('Auth denied: {action} on {streamPath} from {ip}', {
        'event.name': 'video.auth.denied',
        action: req.action,
        streamPath: req.path,
        protocol: req.protocol,
        ip: req.ip,
        reason: 'cedar_deny',
      })
      return c.json({ error: 'permission_denied', reason: 'Cedar policy denied STREAM_VIEW' }, 403)
    }

    logger.debug('Auth allowed: {action} on {streamPath}', {
      'event.name': 'video.auth.allowed',
      action: req.action,
      streamPath: req.path,
      protocol: req.protocol,
      ip: req.ip,
    })
    return c.json({}, 200)
  }

  return app
}
