import { makeExecutor, type GatewayConfig, type ServiceConfig } from '@catalyst/types'
import { getLogger, WideEvent } from '@catalyst/telemetry'
import { createSchema, createYoga, type YogaServerInstance } from 'graphql-yoga'
import { stitchSchemas, type SubschemaConfig } from '@graphql-tools/stitch'
import { schemaFromExecutor } from '@graphql-tools/wrap'
import { SpanStatusCode, type Span, trace } from '@opentelemetry/api'
import type { Counter, Histogram, UpDownCounter } from '@opentelemetry/api'

const logger = getLogger(['catalyst', 'gateway'])

export class GatewayServer {
  private yoga: YogaServerInstance<Record<string, unknown>, Record<string, unknown>> | null = null
  private readonly logger = logger
  private readonly reloadCounter: Counter
  private readonly reloadDuration: Histogram
  private readonly activeSubgraphs: UpDownCounter
  private currentSubgraphCount = 0

  constructor(
    reloadCounter: Counter,
    reloadDuration: Histogram,
    activeSubgraphs: UpDownCounter
  ) {
    this.reloadCounter = reloadCounter
    this.reloadDuration = reloadDuration
    this.activeSubgraphs = activeSubgraphs
    this.createYogaInstance([
      {
        typeDefs: 'type Query { status: String }',
        resolvers: {
          Query: { status: () => 'No services configured.' },
        },
      },
    ])
  }

  async reload(
    config: GatewayConfig
  ): Promise<{ success: true } | { success: false; error: string }> {
    const event = new WideEvent('gateway.reload', this.logger)
    event.set('gateway.service_count', config.services.length)
    try {
      const subschemas = await Promise.all(
        config.services.map(async (service) => {
          await this.validateServiceSdl(service.url, service.token)
          const executor = this.createRemoteExecutor(service.url, service.token)
          const schema = await this.fetchRemoteSchema(executor)
          return { schema, executor }
        })
      )

      if (subschemas.length === 0) {
        event.set('gateway.zero_services', true)
        this.createYogaInstance([
          {
            typeDefs: 'type Query { status: String }',
            resolvers: {
              Query: { status: () => 'No services configured.' },
            },
          },
        ])
      } else {
        const stitchedSchema = stitchSchemas({ subschemas })
        this.createYogaInstance({ schema: stitchedSchema })
      }

      const durationMs = event.durationMs
      this.reloadCounter.add(1, { result: 'success' })
      this.reloadDuration.record(durationMs / 1000)
      const newCount = subschemas.length
      this.activeSubgraphs.add(newCount - this.currentSubgraphCount)
      this.currentSubgraphCount = newCount

      event.set({
        'gateway.duration_ms': durationMs,
        'gateway.subgraph_count': subschemas.length,
      })
      return { success: true }
    } catch (error: unknown) {
      const durationMs = event.durationMs
      this.reloadCounter.add(1, { result: 'failure' })
      this.reloadDuration.record(durationMs / 1000)
      event.setError(error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      event.emit()
    }
  }

  fetch(request: Request, env: unknown, ctx: unknown) {
    if (!this.yoga) {
      return new Response('Gateway not initialized', { status: 503 })
    }
    return this.yoga.fetch(request, env as Record<string, unknown>, ctx as Record<string, unknown>)
  }

  private createYogaInstance(schemaOrConfig: unknown) {
    let schema: unknown
    const config = schemaOrConfig as
      | { schema?: unknown }
      | { typeDefs: unknown; resolvers: unknown }[]
    if (config && 'schema' in config && config.schema) {
      schema = config.schema
    } else if (Array.isArray(config)) {
      schema = createSchema({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        typeDefs: config.map((c) => c.typeDefs) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolvers: config.map((c) => c.resolvers) as any,
      })
    }

    this.yoga = createYoga({
      schema: schema as Parameters<typeof createYoga>[0]['schema'],
      graphqlEndpoint: '/api',
      landingPage: false,
      logging: false,
      maskedErrors: false,
    })
  }

  private createRemoteExecutor(url: string, token?: string): ReturnType<typeof makeExecutor> {
    return makeExecutor(url, token)
  }

  private async fetchRemoteSchema(executor: ReturnType<typeof makeExecutor>) {
    return schemaFromExecutor(executor as Parameters<typeof schemaFromExecutor>[0])
  }

  /**
   * Validate a service's SDL endpoint.
   *
   * On success the span is ended normally.
   * On failure the span records the exception, sets ERROR status, and
   * re-throws so the caller can handle it.
   */
  async validateServiceSdl(url: string, token?: string): Promise<void> {
    const tracer = trace.getTracer('gateway')
    const span: Span = tracer.startSpan('gateway.validate_service_sdl', {
      attributes: {
        'service.url': url,
      },
    })

    try {
      const sdlUrl = `${url}/sdl`
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }
      const response = await fetch(sdlUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: '{ _sdl }',
        }),
      })

      if (!response.ok) {
        throw new Error(`Service returned ${response.status}: ${response.statusText}`)
      }

      const result = (await response.json()) as {
        data?: { _sdl?: string }
        errors?: Array<{ message: string }>
      }

      if (result.errors && result.errors.length > 0) {
        throw new Error(result.errors.map((e) => e.message).join(', '))
      }

      const sdl = result.data?._sdl
      if (!sdl || typeof sdl !== 'string' || sdl.trim().length === 0) {
        throw new Error('Service returned empty or invalid SDL')
      }

      span.end()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      span.recordException(error as Error)
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message,
      })
      span.end()
      throw new Error(`Service validation failed for ${url}: ${message}`)
    }
  }
}

export function createGatewayHandler(gateway: GatewayServer) {
  return (request: Request, env: unknown, ctx: unknown) => {
    return gateway.fetch(request, env, ctx)
  }
}
