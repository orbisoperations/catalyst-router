import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import { TelemetryBuilder } from '@catalyst/telemetry'
import { OrchestratorService, websocket } from './service.js'

const config = loadDefaultConfig()

// -- Telemetry token fetch for authenticated OTLP export --
let otelToken = ''
async function fetchTelemetryToken() {
  if (!config.orchestrator?.auth) return
  const { endpoint, systemToken: sysToken } = config.orchestrator.auth
  const authUrl = endpoint.replace(/^ws/, 'http').replace(/\/rpc$/, '')
  try {
    const res = await fetch(`${authUrl}/telemetry/token`, {
      headers: { Authorization: `Bearer ${sysToken}` },
    })
    if (!res.ok) return
    const body = (await res.json()) as { token: string; expiresAt: string }
    otelToken = body.token
  } catch {
    // Graceful — don't block startup
  }
}

await fetchTelemetryToken()

// Build telemetry with auth credentials if we have a token
let telemetry: ServiceTelemetry | undefined
if (otelToken) {
  try {
    telemetry = await new TelemetryBuilder('orchestrator')
      .withLogger({ category: ['catalyst', 'orchestrator'] })
      .withMetrics()
      .withTracing()
      .withRpcInstrumentation()
      .withAuth({ tokenFn: () => otelToken })
      .build()
  } catch {
    // Falls through to let CatalystService build noop telemetry
  }
}

const orchestrator = await OrchestratorService.create({ config, telemetry })

if (!websocket) {
  throw new Error('WebSocket handler is required')
}
catalystHonoServer(orchestrator.handler, {
  services: [orchestrator],
  port: config.port,
  websocket,
}).start()
