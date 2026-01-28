/**
 * Smoke Test Service
 *
 * Tests @catalyst/telemetry + CatalystService with the observability stack.
 *
 * Usage:
 *   1. Start observability stack:
 *      docker compose -f docker-compose/docker-compose.observability.yaml up -d
 *
 *   2. Run this service:
 *      bun run examples/smoke-test/index.ts
 *
 *   3. Hit endpoints:
 *      curl http://localhost:3000/hello
 *      curl http://localhost:3000/slow
 *      curl http://localhost:3000/error
 *
 *   4. Check observability UIs:
 *      - Jaeger: http://localhost:16686 (traces)
 *      - Prometheus: http://localhost:9090 (metrics)
 *      - InfluxDB: http://localhost:8086 (logs)
 */

import { initTelemetry, getLogger, shutdown } from '@catalyst/telemetry'
import { telemetryMiddleware } from '@catalyst/telemetry/middleware/hono'
import { CatalystService } from '@catalyst/sdk'

// Initialize telemetry FIRST (before any other imports that might create spans)
await initTelemetry({
  serviceName: 'smoke-test',
  serviceVersion: '1.0.0',
  environment: 'development',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
  enableConsole: true,
  logLevel: 'debug',
})

const logger = getLogger('smoke-test')

// Create service
const service = new CatalystService({
  name: 'smoke-test',
  port: 3000,
})

// Add telemetry middleware
service.app.use('*', telemetryMiddleware({ ignorePaths: ['/health'] }))

// Routes
service.app.get('/hello', (c) => {
  logger.info('Hello endpoint hit')
  return c.json({ message: 'Hello from smoke test!' })
})

service.app.get('/slow', async (c) => {
  logger.info('Slow endpoint starting')
  const tracer = service.tracer
  const span = tracer.startSpan('slow-operation')

  // Simulate slow work
  await new Promise((resolve) => setTimeout(resolve, 500))

  span.setAttribute('operation.duration_ms', 500)
  span.end()

  logger.info('Slow endpoint completed')
  return c.json({ message: 'Slow operation complete', duration: 500 })
})

service.app.get('/error', (_c) => {
  logger.error('Error endpoint triggered')
  throw new Error('Intentional error for testing')
})

service.app.get('/user/:id', (c) => {
  const userId = c.req.param('id')
  logger.info('User lookup for {userId}', { userId })
  return c.json({ userId, name: 'Test User' })
})

// Metrics endpoint (manual metric recording)
service.app.get('/metrics-test', (c) => {
  const meter = service.meter
  const counter = meter.createCounter('smoke_test.requests')
  counter.add(1, { endpoint: '/metrics-test' })

  const histogram = meter.createHistogram('smoke_test.response_time')
  histogram.record(Math.random() * 100, { endpoint: '/metrics-test' })

  logger.info('Metrics recorded')
  return c.json({ message: 'Metrics recorded' })
})

// Register shutdown callback
service.onShutdown(async () => {
  logger.info('Shutting down smoke test service')
  await shutdown()
})

logger.info('Smoke test service starting on port {port}', { port: service.port })

export default service.serve()
