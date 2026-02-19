import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { TelemetryBuilder } from '@catalyst/telemetry'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import { websocket } from 'hono/bun'
import { GatewayService } from './service.js'

const config = loadDefaultConfig({ serviceType: 'gateway' })

const authEndpoint = process.env.CATALYST_AUTH_ENDPOINT
const authSystemToken = process.env.CATALYST_SYSTEM_TOKEN

// -- Telemetry token fetch --
let otelToken = ''
const OTEL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const OTEL_REFRESH_THRESHOLD = 0.8
const OTEL_REFRESH_CHECK_INTERVAL = 60 * 60 * 1000
let otelTokenExpiresAt = 0

async function fetchTelemetryToken() {
  if (!authEndpoint || !authSystemToken) return
  try {
    const res = await fetch(`${authEndpoint}/telemetry/token`, {
      headers: { Authorization: `Bearer ${authSystemToken}` },
    })
    if (!res.ok) {
      process.stderr.write(`[gateway] telemetry token fetch failed: ${res.status}\n`)
      return
    }
    const body = (await res.json()) as { token: string; expiresAt: string }
    otelToken = body.token
    otelTokenExpiresAt = new Date(body.expiresAt).getTime()
  } catch (err) {
    process.stderr.write(`[gateway] telemetry token fetch failed: ${err}\n`)
  }
}

// Fetch initial token (graceful — doesn't block startup)
await fetchTelemetryToken()

// Periodic refresh
if (authEndpoint && authSystemToken) {
  setInterval(async () => {
    const now = Date.now()
    const issuedAt = otelTokenExpiresAt - OTEL_TOKEN_TTL_MS
    const tokenAge = now - issuedAt
    if (tokenAge >= OTEL_TOKEN_TTL_MS * OTEL_REFRESH_THRESHOLD) {
      await fetchTelemetryToken()
    }
  }, OTEL_REFRESH_CHECK_INTERVAL)
}

// Build telemetry with auth credentials if we have a token
let telemetry: ServiceTelemetry
try {
  const builder = new TelemetryBuilder('gateway')
    .withLogger({ category: ['catalyst', 'gateway'] })
    .withMetrics()
    .withTracing()
    .withRpcInstrumentation()

  if (otelToken) {
    builder.withAuth({ tokenFn: () => otelToken })
  }

  telemetry = await builder.build()
} catch (err) {
  process.stderr.write(`[gateway] telemetry init failed, falling back to noop: ${err}\n`)
  telemetry = TelemetryBuilder.noop('gateway')
}

const gateway = await GatewayService.create({ config, telemetry })

catalystHonoServer(gateway.handler, {
  services: [gateway],
  port: config.port,
  websocket,
}).start()
