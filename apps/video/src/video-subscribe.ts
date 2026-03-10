import { Hono } from 'hono'
import { SpanStatusCode } from '@opentelemetry/api'
import type { Tracer, Meter, Counter, Histogram } from '@opentelemetry/api'
import { Action } from '@catalyst/authorization'
import { DURATION_BUCKETS, getLogger } from '@catalyst/telemetry'
import type { StreamRelayManager } from './stream-relay-manager.js'
import type { StreamEntry } from './bus-client.js'

const logger = getLogger('video-subscribe')

interface AuthResult {
  success: boolean
  allowed?: boolean
  errorType?: string
  reason?: string
}

interface AuthService {
  evaluate(request: {
    token: string
    action: string
    nodeContext: { nodeId: string; domains: string[] }
    resource: { routeName: string; protocol: string }
  }): Promise<AuthResult>
}

interface VideoSubscribeConfig {
  relayGracePeriodMs: number
  streamAuth: {
    legacyFallback: boolean
  }
  mediamtxApiUrl: string
}

interface VideoSubscribeDeps {
  getCatalog: () => { streams: StreamEntry[] }
  auth: AuthService
  config: VideoSubscribeConfig
  nodeId: string
  domains?: string[]
  relayManager?: StreamRelayManager
  tracer?: Tracer
  meter?: Meter
}

function findStream(
  catalog: { streams: StreamEntry[] },
  streamName: string
): { stream: StreamEntry; scope: 'local' | 'remote' } | undefined {
  const stream = catalog.streams.find((s) => s.name === streamName && s.protocol === 'media')
  if (stream) return { stream, scope: stream.source }
  return undefined
}

function encodeStreamPath(streamName: string): string {
  return streamName.split('/').map(encodeURIComponent).join('/')
}

function buildPlaybackEndpoints(baseUrl: string, streamName: string) {
  const url = new URL(baseUrl)
  const host = url.hostname
  const encoded = encodeStreamPath(streamName)
  return {
    rtsp: `rtsp://${host}:8554/${encoded}`,
    hls: `http://${host}:8888/${encoded}/index.m3u8`,
    webrtc: `http://${host}:8889/${encoded}/whep`,
    srt: `srt://${host}:8890/${encoded}`,
  }
}

export function createVideoSubscribe(deps: VideoSubscribeDeps) {
  const { getCatalog, auth, config, nodeId, domains = [], relayManager, tracer, meter } = deps

  const evaluationsCounter: Counter | undefined = meter?.createCounter('video.auth.evaluations', {
    unit: '{evaluation}',
    description: 'Number of auth evaluations for video subscribe',
  })
  const durationHistogram: Histogram | undefined = meter?.createHistogram('video.auth.duration', {
    unit: 's',
    description: 'Duration of auth evaluations for video subscribe',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS },
  })

  const handler = new Hono()

  handler.post('/subscribe/:streamName{.+}', async (c) => {
    const streamName = c.req.param('streamName')

    const authHeader = c.req.header('Authorization')
    if (!authHeader) {
      return c.json({ success: false, error: 'Authorization header required' }, 401)
    }

    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader

    const catalog = getCatalog()
    const found = findStream(catalog, streamName)
    if (!found) {
      return c.json({ success: false, error: 'Stream not found' }, 404)
    }
    const { scope } = found

    const nodeContext = { nodeId, domains }
    const resource = { routeName: streamName, protocol: 'media' }

    // Evaluate auth with optional OTEL span
    const authStart = performance.now()
    let result: AuthResult

    const evaluateAuth = async (): Promise<AuthResult> => {
      return auth.evaluate({
        token,
        action: Action.STREAM_SUBSCRIBE,
        nodeContext,
        resource,
      })
    }

    try {
      if (tracer) {
        result = await tracer.startActiveSpan(
          'video.auth.evaluate',
          {
            attributes: {
              'video.stream.name': streamName,
              'video.auth.action': Action.STREAM_SUBSCRIBE,
            },
          },
          async (span) => {
            try {
              const r = await evaluateAuth()
              span.setAttribute('video.auth.allowed', !!(r.success && r.allowed))
              span.end()
              return r
            } catch (err) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
              span.end()
              throw err
            }
          }
        )
      } else {
        result = await evaluateAuth()
      }
    } catch (err) {
      const authDurationS = (performance.now() - authStart) / 1000
      const errorType = err instanceof Error ? err.constructor.name : 'Error'
      evaluationsCounter?.add(1, { 'video.auth.result': 'error', 'error.type': errorType })
      durationHistogram?.record(authDurationS)
      logger.error`Auth service error for ${streamName} (${Math.round(authDurationS * 1000)}ms): ${err}`
      return c.json({ success: false, error: 'Forbidden' }, 403)
    }

    const authDurationS = (performance.now() - authStart) / 1000
    if (result.success && result.allowed) {
      evaluationsCounter?.add(1, { 'video.auth.result': 'allowed' })
    } else {
      evaluationsCounter?.add(1, { 'video.auth.result': 'denied' })
    }
    durationHistogram?.record(authDurationS)
    logger.info`Auth evaluated for ${streamName}: allowed=${result.success && result.allowed} (${Math.round(authDurationS * 1000)}ms)`

    if (result.success && result.allowed) {
      // Wrap relay start + endpoint build in a span
      const respond = async () => {
        if (scope === 'remote' && relayManager) {
          await relayManager.addViewer(streamName)
        }
        const playbackEndpoints = buildPlaybackEndpoints(config.mediamtxApiUrl, streamName)
        logger.info`Subscribe granted for ${streamName}`
        return c.json({
          success: true,
          stream: {
            name: streamName,
            protocol: 'media',
            playbackEndpoints,
          },
        })
      }

      if (tracer) {
        return tracer.startActiveSpan(
          'video.subscribe.relay',
          { attributes: { 'video.stream.name': streamName, 'video.stream.scope': scope } },
          async (span) => {
            try {
              const res = await respond()
              span.end()
              return res
            } catch (err) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
              span.end()
              throw err
            }
          }
        )
      }
      return respond()
    }

    if (
      !result.success &&
      result.errorType === 'POLICY_UNAVAILABLE' &&
      config.streamAuth.legacyFallback
    ) {
      logger.info`STREAM_SUBSCRIBE policy unavailable for ${streamName}, falling back to ROUTE_LIST`

      const fallbackStart = performance.now()
      try {
        const fallbackResult = await auth.evaluate({
          token,
          action: Action.ROUTE_LIST,
          nodeContext,
          resource,
        })

        const fallbackDurationS = (performance.now() - fallbackStart) / 1000
        if (fallbackResult.success && fallbackResult.allowed) {
          evaluationsCounter?.add(1, { 'video.auth.result': 'allowed' })
          durationHistogram?.record(fallbackDurationS)
          if (scope === 'remote' && relayManager) {
            await relayManager.addViewer(streamName)
          }
          const playbackEndpoints = buildPlaybackEndpoints(config.mediamtxApiUrl, streamName)
          return c.json({
            success: true,
            stream: {
              name: streamName,
              protocol: 'media',
              playbackEndpoints,
            },
          })
        }
        evaluationsCounter?.add(1, { 'video.auth.result': 'denied' })
        durationHistogram?.record(fallbackDurationS)
      } catch (err) {
        const fallbackDurationS = (performance.now() - fallbackStart) / 1000
        const errorType = err instanceof Error ? err.constructor.name : 'Error'
        evaluationsCounter?.add(1, { 'video.auth.result': 'error', 'error.type': errorType })
        durationHistogram?.record(fallbackDurationS)
        logger.error`Auth fallback error for ${streamName}: ${err}`
      }
    }

    logger.info`Subscribe denied for ${streamName}`
    return c.json({ success: false, error: 'Forbidden' }, 403)
  })

  return handler
}
