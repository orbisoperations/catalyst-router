import { Hono } from 'hono'
import { createYoga, createSchema } from 'graphql-yoga'
import { stitchSchemas } from '@graphql-tools/stitch'

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

  constructor() {
    // Initialize with a default health check schema
    this.createYogaInstance([
      {
        typeDefs: 'type Query { status: String }',
        resolvers: { Query: { status: () => 'Waiting for configuration...' } },
      },
    ])
  }

  async reload(
    config: GatewayConfig
  ): Promise<{ success: true } | { success: false; error: string }> {
    console.log('Reloading gateway with new config...', config)

    try {
      const subschemas = await Promise.all(
        config.services.map(async (service) => {
          // Check if the service exposes an SDL
          await this.validateServiceSdl(service.url, service.token)

          const executor = this.createRemoteExecutor(service.url, service.token)
          const schema = await this.fetchRemoteSchema(executor)
          return {
            schema,
            executor,
          }
        })
      )

      if (subschemas.length === 0) {
        console.warn('No services configured, reverting to default status schema.')
        this.createYogaInstance([
          {
            typeDefs: 'type Query { status: String }',
            resolvers: { Query: { status: () => 'No services configured.' } },
          },
        ])
        return { success: true }
      }

      const stitchedSchema = stitchSchemas({
        subschemas,
      })

      this.createYogaInstance({ schema: stitchedSchema })
      console.log('Gateway reloaded successfully.')
      return { success: true }
    } catch (error: unknown) {
      console.error('Failed to reload gateway:', error)
      const message = error instanceof Error ? error.message : String(error)
      // We do NOT update the yoga instance here, effectively keeping the last known good config.
      return { success: false, error: message }
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
    return async ({ document, variables, operationName, extensions }) => {
      const query = print(document)
      const fetchResult = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ query, variables, operationName, extensions }),
      })
      return fetchResult.json()
    }
  }

  private async fetchRemoteSchema(executor: Executor) {
    const result = (await executor({ document: parse(getIntrospectionQuery()) })) as {
      data?: unknown
      errors?: { message: string }[]
    }
    if (result.errors) {
      throw new Error(result.errors.map((e) => e.message).join('\n'))
    }
    return buildClientSchema(result.data as unknown as IntrospectionQuery)
  }

  private async validateServiceSdl(url: string, token?: string) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Service validation failed for ${url}: ${message}`)
    }
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
