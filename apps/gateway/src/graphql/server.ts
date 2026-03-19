import { Hono } from 'hono'
import { createYoga, createSchema } from 'graphql-yoga'
import { stitchSchemas } from '@graphql-tools/stitch'
import { context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import type { Counter, Histogram, UpDownCounter } from '@opentelemetry/api'
import { TelemetryBuilder, withWideEvent } from '@catalyst/telemetry'
import type { ServiceTelemetry } from '@catalyst/telemetry'

import type { AsyncExecutor, Executor } from '@graphql-tools/utils'
import {
  parse,
  print,
  getIntrospectionQuery,
  buildClientSchema,
  type GraphQLSchema,
  type IntrospectionQuery,
} from 'graphql'
import type { GatewayConfig } from '../rpc/server.js'

export class GatewayGraphqlServer {
  private yoga: ReturnType<typeof createYoga> | null = null
  private readonly telemetry: ServiceTelemetry
  private readonly logger: ServiceTelemetry['logger']
  private readonly reloadCounter: Counter
  private readonly reloadDuration: Histogram
  private readonly activeSubgraphs: UpDownCounter
  private currentSubgraphCount = 0

  constructor(telemetry: ServiceTelemetry = TelemetryBuilder.noop('gateway')) {
    this.telemetry = telemetry
    this.logger = telemetry.logger.getChild('graphql')

    this.reloadCounter = telemetry.meter.createCounter('gateway.schema.reloads', {
      description: 'Number of schema reload attempts',
      unit: '{reload}',
    })
    this.reloadDuration = telemetry.meter.createHistogram('gateway.schema.reload.duration', {
      description: 'Duration of schema reload operations',
      unit: 's',
    })
    this.activeSubgraphs = telemetry.meter.createUpDownCounter('gateway.subgraph.active', {
      description: 'Number of active subgraph services',
      unit: '{subgraph}',
    })

    // Initialize with a default health check schema
    this.createYogaInstance([
      {
        typeDefs: 'type Query { status: String }',
        resolvers: {
          Query: { status: () => 'Waiting for configuration...' },
        },
      },
    ])
  }

  async reload(
    config: GatewayConfig
  ): Promise<{ success: true } | { success: false; error: string }> {
    return withWideEvent('gateway.reload', this.logger, async (event) => {
      event.set('gateway.service_count', config.services.length)
      try {
        const subschemas = await Promise.all(
          config.services.map(async (service) => {
            await this.validateServiceSdl(service.url, service.token)
            event.log.info('SDL validated for {url}', {
              'subgraph.url': service.url,
              url: service.url,
            })
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
      }
    })
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
        typeDefs: (config as { typeDefs: any }[]).map((c) => c.typeDefs),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolvers: (config as { resolvers: any }[]).map((c) => c.resolvers),
      })
    } else {
      schema = config
    }

    this.yoga = createYoga({
      schema: schema as GraphQLSchema,
      graphqlEndpoint: '/graphql',
      landingPage: false,
    })
  }

  private createRemoteExecutor(url: string, token?: string): AsyncExecutor {
    const tracer = this.telemetry.tracer
    const hostname = new URL(url).hostname
    return async ({ document, variables, operationName, extensions }) => {
      const query = print(document)
      return tracer.startActiveSpan(
        `gateway subgraph ${hostname}`,
        { kind: SpanKind.CLIENT, attributes: { 'url.full': url } },
        async (span) => {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          }
          // Inject W3C traceparent into outbound headers
          propagation.inject(context.active(), headers)

          try {
            const res = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                query,
                variables,
                operationName,
                extensions,
              }),
            })
            const result = await res.json()
            span.end()
            return result
          } catch (err) {
            span.recordException(err as Error)
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            })
            span.end()
            throw err
          }
        }
      )
    }
  }

  private async fetchRemoteSchema(executor: Executor) {
    const result = (await executor({
      document: parse(getIntrospectionQuery()),
    })) as {
      data?: unknown
      errors?: { message: string }[]
    }
    if (result.errors) {
      throw new Error(result.errors.map((e) => e.message).join('\n'))
    }
    return buildClientSchema(result.data as unknown as IntrospectionQuery)
  }

  private async validateServiceSdl(url: string, token?: string) {
    const tracer = this.telemetry.tracer
    const hostname = new URL(url).hostname
    return tracer.startActiveSpan(
      `gateway validate-sdl ${hostname}`,
      { kind: SpanKind.CLIENT, attributes: { 'url.full': url } },
      async (span) => {
        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          }
          propagation.inject(context.active(), headers)

          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ query: 'query { _sdl }' }),
          })

          if (!res.ok) {
            throw new Error(`Service returned status ${res.status}`)
          }

          const result = (await res.json()) as {
            data?: { _sdl?: string }
            errors?: { message: string }[]
          }
          if (result.errors) {
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
    )
  }
}

export function createGatewayHandler(gateway?: GatewayGraphqlServer): {
  app: Hono
  server: GatewayGraphqlServer
} {
  const server = gateway || new GatewayGraphqlServer()
  const app = new Hono()
  app.all('/*', (c) => server.fetch(c.req.raw, c.env, {}))
  return { app, server }
}
