import { Hono } from 'hono'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import { createMetricsRoutes } from './routes/metrics.js'
import { createTracesRoutes } from './routes/traces.js'
import { createLogsRoutes } from './routes/logs.js'

export interface StatusPageConfig {
  prometheusUrl: string
  jaegerUrl: string
  influxdbUrl: string
}

function loadStatusPageConfig(): StatusPageConfig {
  return {
    prometheusUrl: process.env.PROMETHEUS_URL ?? 'http://prometheus:9090',
    jaegerUrl: process.env.JAEGER_URL ?? 'http://jaeger:16686',
    influxdbUrl: process.env.INFLUXDB_URL ?? 'http://influxdb:8086',
  }
}

export class StatusPageService extends CatalystService {
  readonly info = { name: 'status-page', version: '0.0.0' }
  readonly handler = new Hono()
  readonly backends: StatusPageConfig

  constructor(options: CatalystServiceOptions) {
    super(options)
    this.backends = loadStatusPageConfig()
  }

  protected async onInitialize(): Promise<void> {
    this.handler.get('/', (c) => c.text('Catalyst Status Page'))

    this.handler.get('/api/status', (c) =>
      c.json({
        backends: {
          prometheus: this.backends.prometheusUrl,
          jaeger: this.backends.jaegerUrl,
          influxdb: this.backends.influxdbUrl,
        },
      })
    )

    this.handler.route('/api/metrics', createMetricsRoutes(this.backends.prometheusUrl))
    this.handler.route('/api/traces', createTracesRoutes(this.backends.jaegerUrl))
    this.handler.route('/api/logs', createLogsRoutes(this.backends.influxdbUrl))

    this.telemetry.logger.info`StatusPageService initialized`
  }
}
