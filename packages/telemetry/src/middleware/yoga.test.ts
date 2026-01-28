import { afterEach, describe, expect, it } from 'bun:test'
import { propagation, trace } from '@opentelemetry/api'
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { createSchema, createYoga } from 'graphql-yoga'
import { createYogaTelemetryPlugin } from './yoga'

let currentProvider: NodeTracerProvider | null = null

function setupTracer() {
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'test' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  provider.register()
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  currentProvider = provider
  return { exporter, provider }
}

const testSchema = createSchema({
  typeDefs: /* GraphQL */ `
    type Query {
      hello: String!
      fail: String!
    }
  `,
  resolvers: {
    Query: {
      hello: () => 'world',
      fail: () => {
        throw new Error('resolver error')
      },
    },
  },
})

function createTestYoga(pluginOptions?: Parameters<typeof createYogaTelemetryPlugin>[0]) {
  return createYoga({
    schema: testSchema,
    plugins: [createYogaTelemetryPlugin(pluginOptions)],
  })
}

function postGraphQL(yoga: ReturnType<typeof createYoga>, query: string) {
  return yoga.fetch(
    new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
  )
}

describe('createYogaTelemetryPlugin', () => {
  afterEach(async () => {
    if (currentProvider) {
      await currentProvider.shutdown()
      currentProvider = null
    }
    trace.disable()
    propagation.disable()
  })

  describe('plugin shape', () => {
    it('returns a valid Envelop plugin', () => {
      const plugin = createYogaTelemetryPlugin()
      expect(plugin).toBeDefined()
      expect(typeof plugin).toBe('object')
    })
  })

  describe('tracing', () => {
    it('creates spans for GraphQL execution', async () => {
      const { exporter } = setupTracer()
      const yoga = createTestYoga()

      await postGraphQL(yoga, '{ hello }')

      const spans = exporter.getFinishedSpans()
      expect(spans.length).toBeGreaterThan(0)

      // @envelop/opentelemetry names operation spans as "query.anonymous", "query.HelloOp", etc.
      const spanNames = spans.map((s) => s.name)
      const hasQuerySpan = spanNames.some(
        (n) => n.startsWith('query.') || n.startsWith('mutation.') || n.startsWith('subscription.')
      )
      expect(hasQuerySpan).toBe(true)
    })

    it('creates resolver-level spans by default', async () => {
      const { exporter } = setupTracer()
      const yoga = createTestYoga() // resolvers defaults to true

      await postGraphQL(yoga, '{ hello }')

      const spanNames = exporter.getFinishedSpans().map((s) => s.name)
      expect(spanNames).toContain('Query.hello')
    })

    it('suppresses resolver-level spans when resolvers is false', async () => {
      const { exporter } = setupTracer()
      const yoga = createTestYoga({ resolvers: false })

      await postGraphQL(yoga, '{ hello }')

      const spanNames = exporter.getFinishedSpans().map((s) => s.name)
      // Should have the operation span but NOT the resolver span
      const hasOperationSpan = spanNames.some((n) => n.startsWith('query.'))
      const hasResolverSpan = spanNames.includes('Query.hello')
      expect(hasOperationSpan).toBe(true)
      expect(hasResolverSpan).toBe(false)
    })

    it('includes operation name in span attributes when provided', async () => {
      const { exporter } = setupTracer()
      const yoga = createTestYoga()

      await postGraphQL(yoga, 'query HelloOp { hello }')

      const spans = exporter.getFinishedSpans()
      const hasOpName = spans.some((s) => {
        const attrs = s.attributes
        return (
          attrs['graphql.execute.operationName'] === 'HelloOp' ||
          attrs['graphql.operation.name'] === 'HelloOp' ||
          s.name.includes('HelloOp')
        )
      })
      expect(hasOpName).toBe(true)
    })

    it('records error attributes when a resolver throws', async () => {
      const { exporter } = setupTracer()
      const yoga = createTestYoga()

      const res = await postGraphQL(yoga, '{ fail }')
      const body = await res.json()

      // Yoga masks error messages by default ("Unexpected error.")
      expect(body.errors).toBeDefined()
      expect(body.errors.length).toBeGreaterThan(0)

      const spans = exporter.getFinishedSpans()
      expect(spans.length).toBeGreaterThan(0)

      // @envelop/opentelemetry records the exception on the operation span,
      // not on a separate resolver span (resolver span is not emitted on throw)
      const operationSpan = spans.find((s) => s.name.startsWith('query.'))
      expect(operationSpan).toBeDefined()
      const hasException = operationSpan!.events.some((e) => e.name === 'exception')
      expect(hasException).toBe(true)
    })
  })

  describe('options', () => {
    it('accepts custom options without throwing', () => {
      const plugin = createYogaTelemetryPlugin({
        resolvers: true,
        variables: false,
        result: false,
        document: false,
      })
      expect(plugin).toBeDefined()
    })
  })
})
