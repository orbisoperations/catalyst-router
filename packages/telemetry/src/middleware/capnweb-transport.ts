/**
 * capnweb transport-level trace context propagation
 *
 * Wraps capnweb's RpcTransport to inject/extract W3C traceparent headers
 * as a prefix on every WebSocket message. This enables cross-service
 * distributed tracing over capnweb's JSON wire format.
 *
 * Wire format:
 *   Before: ["push",["pipeline",0,["methodName"],arg1,arg2]]
 *   After:  00-<traceId>-<spanId>-01\n["push",["pipeline",0,["methodName"],arg1,arg2]]
 *
 * Backward-compatible: messages without the prefix are processed as-is.
 *
 * @see https://www.w3.org/TR/trace-context/#traceparent-header
 */

import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api'
import { RPC_CLIENT_INFO_KEY, type RpcConnectionInfo } from './capnweb.js'

/** Matches capnweb's RpcTransport interface (send/receive/abort?) */
export interface RpcTransport {
  send(message: string): Promise<void>
  receive(): Promise<string>
  abort?(reason: unknown): void
}

/**
 * Splits a traceparent prefix from a WebSocket message.
 *
 * If the message starts with '00-' (W3C traceparent version byte),
 * the first line is treated as the traceparent header.
 * Otherwise returns null traceparent and the original message.
 */
export function extractTraceEnvelope(msg: string): {
  traceparent: string | null
  message: string
} {
  if (msg.startsWith('00-')) {
    const newlineIdx = msg.indexOf('\n')
    if (newlineIdx !== -1) {
      return {
        traceparent: msg.slice(0, newlineIdx),
        message: msg.slice(newlineIdx + 1),
      }
    }
  }
  return { traceparent: null, message: msg }
}

/**
 * Executes a callback within the OTEL context restored from a traceparent string.
 * If traceparent is null, runs in the current context (no-op).
 */
export function withTraceContext<T>(traceparent: string | null, fn: () => T): T {
  if (!traceparent) return fn()

  const carrier: Record<string, string> = { traceparent }
  const extracted = propagation.extract(ROOT_CONTEXT, carrier)
  return context.with(extracted, fn)
}

/**
 * Wraps an RpcTransport to prepend the active OTEL traceparent to outgoing messages
 * and strip it from incoming messages (future-proof for bidirectional propagation).
 */
export function createTracePropagatingTransport(inner: RpcTransport): RpcTransport {
  return {
    async send(message: string): Promise<void> {
      const carrier: Record<string, string> = {}
      propagation.inject(context.active(), carrier)

      if (carrier.traceparent) {
        return inner.send(`${carrier.traceparent}\n${message}`)
      }
      return inner.send(message)
    },

    async receive(): Promise<string> {
      const raw = await inner.receive()
      const { message } = extractTraceEnvelope(raw)
      return message
    },

    abort: inner.abort?.bind(inner),
  }
}

/**
 * Adapts a WebSocket into capnweb's RpcTransport interface.
 *
 * This is needed when you want to insert a createTracePropagatingTransport
 * between the raw WebSocket and an RpcSession.
 *
 * Note: receive() does not support concurrent calls. A second pending
 * receive() will throw until the first resolves or rejects.
 */
export class WebSocketTransportAdapter implements RpcTransport {
  private static readonly MAX_QUEUE_SIZE = 10_000
  private messageQueue: string[] = []
  private waiting: { resolve: (msg: string) => void; reject: (err: Error) => void } | null = null
  private closed = false
  private closeError: Error | null = null
  private readonly onMessage = (event: MessageEvent) => {
    const data = typeof event.data === 'string' ? event.data : String(event.data)
    if (this.waiting) {
      const { resolve } = this.waiting
      this.waiting = null
      resolve(data)
    } else {
      if (this.messageQueue.length >= WebSocketTransportAdapter.MAX_QUEUE_SIZE) {
        this.messageQueue.shift()
      }
      this.messageQueue.push(data)
    }
  }
  private readonly onClose = () => {
    this.closed = true
    this.closeError = new Error('WebSocket closed')
    if (this.waiting) {
      const { reject } = this.waiting
      this.waiting = null
      reject(this.closeError)
    }
    this.cleanup()
  }
  private readonly onError = () => {
    this.closed = true
    this.closeError = new Error('WebSocket error')
    if (this.waiting) {
      const { reject } = this.waiting
      this.waiting = null
      reject(this.closeError)
    }
    this.cleanup()
  }

  constructor(private ws: WebSocket) {
    ws.addEventListener('message', this.onMessage)
    ws.addEventListener('close', this.onClose)
    ws.addEventListener('error', this.onError)
  }

  async send(message: string): Promise<void> {
    if (this.closed) throw new Error('WebSocket is closed')
    this.ws.send(message)
  }

  async receive(): Promise<string> {
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift()!
    }
    if (this.closed) {
      throw this.closeError ?? new Error('WebSocket closed')
    }
    if (this.waiting) {
      throw new Error('Concurrent receive() not supported')
    }
    return new Promise<string>((resolve, reject) => {
      this.waiting = { resolve, reject }
    })
  }

  abort(reason: unknown): void {
    this.ws.close(1000, typeof reason === 'string' ? reason : 'aborted')
  }

  dispose(): void {
    this.closed = true
    this.messageQueue.length = 0
    if (this.waiting) {
      const { reject } = this.waiting
      this.waiting = null
      reject(new Error('Transport disposed'))
    }
    this.cleanup()
  }

  private cleanup(): void {
    // Guard for environments that may not implement removeEventListener
    if (typeof this.ws.removeEventListener !== 'function') return
    this.ws.removeEventListener('message', this.onMessage)
    this.ws.removeEventListener('close', this.onClose)
    this.ws.removeEventListener('error', this.onError)
  }
}

/**
 * WSEvents shape expected by Hono's upgradeWebSocket.
 * We only type the fields we intercept.
 */
interface WSEvents {
  onOpen?(evt: unknown, ws: unknown): void
  onMessage?(evt: { data: unknown } & Record<string, unknown>, ws: unknown): void
  onClose?(evt: unknown, ws: unknown): void
  onError?(evt: unknown, ws: unknown): void
}

type UpgradeWebSocketFn = (createEvents: (c: unknown) => WSEvents | Promise<WSEvents>) => unknown

export interface InstrumentUpgradeOptions {
  /** Extract client connection info from Hono context for client.address/port span attributes. */
  getConnectionInfo?: (c: unknown) => RpcConnectionInfo
}

/**
 * Wraps Hono's upgradeWebSocket so that incoming WebSocket messages
 * have their traceparent prefix extracted and OTEL context restored
 * before capnweb processes the message.
 *
 * Usage:
 * ```typescript
 * const tracedUpgradeWebSocket = instrumentUpgradeWebSocket(upgradeWebSocket)
 * return newRpcResponse(c, rpcServer, { upgradeWebSocket: tracedUpgradeWebSocket })
 * ```
 */
export function instrumentUpgradeWebSocket<T extends UpgradeWebSocketFn>(
  original: T,
  options?: InstrumentUpgradeOptions
): T {
  const wrapped = ((createEvents: (c: unknown) => WSEvents | Promise<WSEvents>) => {
    return original(async (c: unknown) => {
      const events = await createEvents(c)
      const originalOnMessage = events.onMessage
      const connectionInfo = options?.getConnectionInfo?.(c)

      if (originalOnMessage) {
        events.onMessage = (evt, ws) => {
          const raw = typeof evt.data === 'string' ? evt.data : String(evt.data)
          const { traceparent, message } = extractTraceEnvelope(raw)

          const patchedEvt = { ...evt, data: message }
          withTraceContext(traceparent, () => {
            if (connectionInfo) {
              const ctx = context.active().setValue(RPC_CLIENT_INFO_KEY, connectionInfo)
              context.with(ctx, () => originalOnMessage(patchedEvt, ws))
            } else {
              originalOnMessage(patchedEvt, ws)
            }
          })
        }
      }

      return events
    })
  }) as T

  return wrapped
}
