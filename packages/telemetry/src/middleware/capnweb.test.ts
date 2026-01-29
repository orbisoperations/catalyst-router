/**
 * Tests for capnweb RPC instrumentation
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { instrumentRpcTarget, instrumentPublicApi } from './capnweb'

function setupTracer() {
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'test' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  provider.register()
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  return { exporter, provider }
}

describe('instrumentRpcTarget', () => {
  afterEach(() => {
    trace.disable()
    propagation.disable()
  })

  it('creates spans for async method calls with correct attributes', async () => {
    const { exporter } = setupTracer()
    const target = {
      async greet(name: string) {
        return { success: true, message: `Hello, ${name}!` }
      },
    }

    const instrumented = instrumentRpcTarget(target, { serviceName: 'test' })
    const result = await instrumented.greet('World')

    expect(result).toEqual({ success: true, message: 'Hello, World!' })

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)

    const span = spans[0]
    expect(span.name).toBe('test/greet')
    expect(span.attributes['rpc.system.name']).toBe('capnweb')
    expect(span.attributes['rpc.method']).toBe('test/greet')
    expect(span.status.code).toBe(SpanStatusCode.OK)
  })

  it('sets SpanKind.SERVER per OTEL RPC spec', async () => {
    const { exporter } = setupTracer()
    const target = {
      async process() {
        return { success: true }
      },
    }

    const instrumented = instrumentRpcTarget(target)
    await instrumented.process()

    const span = exporter.getFinishedSpans()[0]
    expect(span.kind).toBe(SpanKind.SERVER)
  })

  it('records errors from thrown exceptions with error.type', async () => {
    const { exporter } = setupTracer()
    const target = {
      async fail() {
        throw new Error('Something went wrong')
      },
    }

    const instrumented = instrumentRpcTarget(target)

    await expect(instrumented.fail()).rejects.toThrow('Something went wrong')

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)

    const span = spans[0]
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.status.message).toBe('Something went wrong')
    expect(span.attributes['error.type']).toBe('Error')
    expect(span.events).toHaveLength(1)
    expect(span.events[0].name).toBe('exception')
  })

  it('uses exception constructor name for error.type', async () => {
    const { exporter } = setupTracer()

    class CustomError extends Error {
      constructor(message: string) {
        super(message)
        this.name = 'CustomError'
      }
    }

    const target = {
      async fail() {
        throw new CustomError('Custom failure')
      },
    }

    const instrumented = instrumentRpcTarget(target)
    await expect(instrumented.fail()).rejects.toThrow('Custom failure')

    const span = exporter.getFinishedSpans()[0]
    expect(span.attributes['error.type']).toBe('CustomError')
  })

  it('detects capnweb-style error responses with error.type', async () => {
    const { exporter } = setupTracer()
    const target = {
      async badRequest() {
        return { success: false, error: 'Invalid input' }
      },
    }

    const instrumented = instrumentRpcTarget(target, { serviceName: 'api' })
    const result = await instrumented.badRequest()

    expect(result).toEqual({ success: false, error: 'Invalid input' })

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)

    const span = spans[0]
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.status.message).toBe('Invalid input')
    expect(span.attributes['error.type']).toBe('RpcError')
    expect(span.attributes['catalyst.rpc.response.error']).toBe('Invalid input')
  })

  it('detects { valid: false } error responses (verifyToken pattern)', async () => {
    const { exporter } = setupTracer()
    const target = {
      async verifyToken() {
        return { valid: false, error: 'Token expired' }
      },
    }

    const instrumented = instrumentRpcTarget(target, { serviceName: 'auth' })
    const result = await instrumented.verifyToken()

    expect(result).toEqual({ valid: false, error: 'Token expired' })

    const span = exporter.getFinishedSpans()[0]
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.status.message).toBe('Token expired')
    expect(span.attributes['error.type']).toBe('RpcError')
  })

  it('treats { valid: true } as success', async () => {
    const { exporter } = setupTracer()
    const target = {
      async verifyToken() {
        return { valid: true, payload: { sub: 'user-1' } }
      },
    }

    const instrumented = instrumentRpcTarget(target, { serviceName: 'auth' })
    await instrumented.verifyToken()

    const span = exporter.getFinishedSpans()[0]
    expect(span.status.code).toBe(SpanStatusCode.OK)
  })

  it('skips methods starting with underscore', async () => {
    const { exporter } = setupTracer()
    const target = {
      async _internal() {
        return 'internal'
      },
      async publicMethod() {
        return 'public'
      },
    }

    const instrumented = instrumentRpcTarget(target)

    await instrumented._internal()
    await instrumented.publicMethod()

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe('rpc/publicMethod')
  })

  it('skips methods in ignoreMethods list', async () => {
    const { exporter } = setupTracer()
    const target = {
      async ping() {
        return 'pong'
      },
      async process() {
        return 'done'
      },
    }

    const instrumented = instrumentRpcTarget(target, {
      ignoreMethods: ['ping'],
    })

    await instrumented.ping()
    await instrumented.process()

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe('rpc/process')
  })

  it('records sanitized arguments when enabled', async () => {
    const { exporter } = setupTracer()
    const target = {
      async login(_credentials: { username: string; password: string }) {
        return { success: true }
      },
    }

    const instrumented = instrumentRpcTarget(target, {
      serviceName: 'auth',
      recordArguments: true,
    })

    await instrumented.login({ username: 'user', password: 'secret123' })

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)

    const argsAttr = spans[0].attributes['catalyst.rpc.request.args'] as string
    expect(argsAttr).toBeDefined()

    const parsed = JSON.parse(argsAttr)
    // Password should be redacted by sanitizeAttributes
    expect(parsed[0].password).toBe('[REDACTED]')
    expect(parsed[0].username).toBe('user')
  })

  it('passes through non-function properties', () => {
    setupTracer()
    const target = {
      name: 'TestService',
      version: 1,
      async method() {
        return 'ok'
      },
    }

    const instrumented = instrumentRpcTarget(target)

    expect(instrumented.name).toBe('TestService')
    expect(instrumented.version).toBe(1)
  })

  it('preserves this context in method calls', async () => {
    const { exporter } = setupTracer()
    const target = {
      prefix: 'Hello',
      async greet(name: string) {
        return `${this.prefix}, ${name}!`
      },
    }

    const instrumented = instrumentRpcTarget(target)
    const result = await instrumented.greet('World')

    expect(result).toBe('Hello, World!')
    expect(exporter.getFinishedSpans()).toHaveLength(1)
  })

  it('uses default service name when not provided', async () => {
    const { exporter } = setupTracer()
    const target = {
      async doSomething() {
        return 'done'
      },
    }

    const instrumented = instrumentRpcTarget(target)
    await instrumented.doSomething()

    const span = exporter.getFinishedSpans()[0]
    expect(span.name).toBe('rpc/doSomething')
    expect(span.attributes['rpc.method']).toBe('rpc/doSomething')
  })
})

describe('instrumentPublicApi', () => {
  afterEach(() => {
    trace.disable()
    propagation.disable()
  })

  it('wraps publicApi() method result', async () => {
    const { exporter } = setupTracer()

    class MockService {
      publicApi() {
        return {
          async getData() {
            return { success: true, data: [1, 2, 3] }
          },
        }
      }
    }

    const service = new MockService()
    const api = instrumentPublicApi(service, 'mock-service')

    const result = await api.getData()
    expect(result).toEqual({ success: true, data: [1, 2, 3] })

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe('mock-service/getData')
    expect(spans[0].kind).toBe(SpanKind.SERVER)
  })
})
