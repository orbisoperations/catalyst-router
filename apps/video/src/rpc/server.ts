import { Hono } from 'hono'
import { newRpcResponse } from '@hono/capnweb'
import { RpcTarget } from 'capnweb'
import { getUpgradeWebSocket } from '@catalyst/service'
import {
  MediaRouteConfigSchema,
  type MediaRouteConfig,
  type StreamListItem,
  type UpdateResult,
} from '../types.js'
import type { StreamState } from '../state/stream-state.js'

export class VideoRpcServer extends RpcTarget {
  constructor(
    private updateCallback: (config: MediaRouteConfig) => Promise<UpdateResult>,
    private streamState: StreamState
  ) {
    super()
  }

  async updateMediaRoutes(config: unknown): Promise<UpdateResult> {
    const result = MediaRouteConfigSchema.safeParse(config)
    if (!result.success) {
      return { success: false, error: 'Malformed video stream config' }
    }
    return this.updateCallback(result.data)
  }

  async getStreams(): Promise<{ streams: StreamListItem[] }> {
    return { streams: this.streamState.listAll() }
  }
}

export function createRpcHandler(rpcServer: RpcTarget): Hono {
  const app = new Hono()
  app.get('/', (c) => {
    return newRpcResponse(c, rpcServer, {
      upgradeWebSocket: getUpgradeWebSocket(c),
    })
  })
  return app
}
