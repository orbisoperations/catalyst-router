import { Hono } from 'hono'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import { EnvoyRpcServer, createRpcHandler } from './rpc/server.js'

export class EnvoyService extends CatalystService {
  readonly info = { name: 'envoy', version: '0.0.0' }
  readonly handler = new Hono()

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  protected async onInitialize(): Promise<void> {
    const rpcServer = new EnvoyRpcServer(this.telemetry)
    const instrumentedRpc = this.telemetry.instrumentRpc(rpcServer)
    const rpcApp = createRpcHandler(instrumentedRpc)

    this.handler.get('/', (c) => c.text('Catalyst Envoy Service is running.'))
    this.handler.route('/api', rpcApp)
  }
}
