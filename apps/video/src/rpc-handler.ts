import { Hono } from 'hono'
import { newRpcResponse } from '@hono/capnweb'
import { getUpgradeWebSocket } from '@catalyst/service'
import { getLogger } from '@catalyst/telemetry'

import type { VideoRpcServer } from './rpc-server.js'

const logger = getLogger(['video', 'rpc-handler'])

/**
 * Wraps `upgradeWebSocket` to inject an `onClose` handler that fires when
 * the orchestrator disconnects.  The wrapper intercepts the event factory
 * and appends the close callback without breaking the capnweb message
 * handling that `newRpcResponse` sets up internally.
 */
function withDisconnectHook(
  upgradeWebSocket: ReturnType<typeof getUpgradeWebSocket>,
  onDisconnect: () => void
): ReturnType<typeof getUpgradeWebSocket> {
  // upgradeWebSocket signature: (createEvents) => Response
  // createEvents: (c) => WSEvents { onOpen, onMessage, onClose, onError }
  // We return a new events object (spread) to avoid mutating capnweb internals.
  type CreateEvents = (c: unknown) => {
    onClose?: (...args: unknown[]) => void
    onError?: (...args: unknown[]) => void
    [k: string]: unknown
  }
  const wrapped = ((createEvents: CreateEvents) => {
    return (upgradeWebSocket as (fn: CreateEvents) => unknown)((c: unknown) => {
      const events = createEvents(c)
      const originalOnClose = events.onClose
      const originalOnError = events.onError
      return {
        ...events,
        onClose: (...args: unknown[]) => {
          originalOnClose?.(...args)
          onDisconnect()
        },
        onError: (...args: unknown[]) => {
          originalOnError?.(...args)
          onDisconnect()
        },
      }
    })
  }) as typeof upgradeWebSocket
  return wrapped
}

/**
 * Creates a Hono sub-app that mounts the video RPC server at `/`
 * (intended to be mounted at `/api` on the parent handler).
 *
 * Handles WebSocket lifecycle: when the orchestrator connection closes,
 * `rpcServer.handleDisconnect()` is called automatically.
 */
export function createVideoRpcHandler(rpcServer: VideoRpcServer): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    const baseUpgrade = getUpgradeWebSocket(c)

    // Per-connection disconnect guard: only fire handleDisconnect once per connection,
    // and only if a newer connection hasn't already replaced this one.
    let disconnected = false
    const onDisconnect = () => {
      if (disconnected) return
      disconnected = true
      logger.info`Orchestrator WebSocket closed`
      rpcServer.handleDisconnect()
    }

    const upgrade = withDisconnectHook(baseUpgrade, onDisconnect)

    return newRpcResponse(c, rpcServer, {
      upgradeWebSocket: upgrade,
    })
  })

  return app
}
