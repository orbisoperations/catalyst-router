import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import { Hono } from 'hono'
import { CatalystRpcServer } from './server/rpc.js'

export class NodeService extends CatalystService {
  readonly info = { name: 'node', version: '0.0.0' }
  readonly handler = new Hono()

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  private _rpcServer: CatalystRpcServer | undefined

  get rpcServer(): CatalystRpcServer {
    if (!this._rpcServer) {
      throw new Error('NodeService not initialized. Call initialize() or use static create().')
    }
    return this._rpcServer
  }

  protected override async onInitialize(): Promise<void> {
    this._rpcServer = new CatalystRpcServer()
    this.telemetry.logger.info`RPC server initialized`
  }
}
