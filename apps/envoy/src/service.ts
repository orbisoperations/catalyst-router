import { Hono } from 'hono'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import { EnvoyRpcServer, createRpcHandler } from './rpc/server.js'
import { createSnapshotCache } from './xds/snapshot-cache.js'
import { XdsControlPlane } from './xds/control-plane.js'

export class EnvoyService extends CatalystService {
  readonly info = { name: 'envoy', version: '0.0.0' }
  readonly handler = new Hono()
  private controlPlane?: XdsControlPlane

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  protected async onInitialize(): Promise<void> {
    const snapshotCache = createSnapshotCache()
    const bindAddress = this.config.envoy?.bindAddress ?? '0.0.0.0'

    const rpcServer = new EnvoyRpcServer({
      telemetry: this.telemetry,
      snapshotCache,
      bindAddress,
    })
    const instrumentedRpc = this.telemetry.instrumentRpc(rpcServer)
    const rpcApp = createRpcHandler(instrumentedRpc)

    this.handler.get('/', (c) => c.text('Catalyst Envoy Service is running.'))
    this.telemetry.logger
      .warn`RPC endpoint /api has no authentication — restrict network access in production`
    this.handler.route('/api', rpcApp)

    // Start the xDS gRPC ADS server if an xDS port is configured
    const xdsPort = this.config.envoy?.xdsPort
    if (xdsPort) {
      this.controlPlane = new XdsControlPlane({
        port: xdsPort,
        bindAddress,
        snapshotCache,
        telemetry: this.telemetry,
      })
      await this.controlPlane.start()
    }
  }

  protected async onShutdown(): Promise<void> {
    await this.controlPlane?.shutdown()
  }
}
