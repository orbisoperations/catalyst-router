import type { PeerInfo, PeerRecord } from '@catalyst/routing'
import { getLogger } from '@catalyst/telemetry'
import type { ConnectionPool } from './connection-pool.js'
import type { Propagation, UpdateMessage } from './api-types.js'

export type { Propagation, UpdateMessage } from './api-types.js'

export class PeerTransport {
  private readonly logger = getLogger(['catalyst', 'peer-transport'])

  constructor(
    private readonly pool: ConnectionPool,
    private readonly nodeToken?: string,
    private readonly rpcTimeoutMs: number = 10_000
  ) {}

  private withTimeout<T>(fn: () => Promise<T>, operation: string, peerName: string): Promise<T> {
    let timeoutId: NodeJS.Timeout
    return Promise.race([
      fn().finally(() => clearTimeout(timeoutId)),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              new Error(`RPC timeout: ${operation} to ${peerName} after ${this.rpcTimeoutMs}ms`)
            ),
          this.rpcTimeoutMs
        )
      }),
    ])
  }

  private getToken(peer: PeerRecord): string {
    const token = peer.peerToken || this.nodeToken
    if (!token) {
      throw new Error(`No peerToken for ${peer.name} and no nodeToken configured`)
    }
    return token
  }

  private getStub(peer: PeerRecord) {
    if (!peer.endpoint) {
      this.logger.error`No endpoint for peer ${peer.name}`
      return undefined
    }
    return this.pool.get(peer.endpoint)
  }

  async sendUpdate(peer: PeerRecord, localNode: PeerInfo, update: UpdateMessage): Promise<void> {
    const token = this.getToken(peer)
    const stub = this.getStub(peer)
    if (!stub) return
    const result = await this.withTimeout(
      async () => stub.getIBGPClient(token),
      'getIBGPClient',
      peer.name
    )
    if (!result.success) {
      this.logger.error`Failed to get iBGP client for ${peer.name}: ${result.error}`
      return
    }
    await this.withTimeout(async () => result.client.update(localNode, update), 'update', peer.name)
  }

  async sendOpen(peer: PeerRecord, localNode: PeerInfo): Promise<void> {
    const token = this.getToken(peer)
    const stub = this.getStub(peer)
    if (!stub) return
    const result = await this.withTimeout(
      async () => stub.getIBGPClient(token),
      'getIBGPClient',
      peer.name
    )
    if (!result.success) {
      this.logger.error`Failed to get iBGP client for ${peer.name}: ${result.error}`
      return
    }
    const openResult = await this.withTimeout(
      async () => result.client.open(localNode),
      'open',
      peer.name
    )
    if (!openResult.success) {
      this.logger.error`Failed to open connection to ${peer.name}: ${openResult.error}`
    }
  }

  async sendClose(
    peer: PeerRecord,
    localNode: PeerInfo,
    code: number,
    reason?: string
  ): Promise<void> {
    const token = this.getToken(peer)
    const stub = this.getStub(peer)
    if (!stub) return
    const result = await this.withTimeout(
      async () => stub.getIBGPClient(token),
      'getIBGPClient',
      peer.name
    )
    if (!result.success) {
      this.logger.error`Failed to get iBGP client for ${peer.name}: ${result.error}`
      return
    }
    await this.withTimeout(
      async () => result.client.close(localNode, code, reason),
      'close',
      peer.name
    )
  }

  async fanOut(propagations: Propagation[]): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(
      propagations.map((p) => {
        switch (p.type) {
          case 'update':
            return this.sendUpdate(p.peer, p.localNode, p.update)
          case 'open':
            return this.sendOpen(p.peer, p.localNode)
          case 'close':
            return this.sendClose(p.peer, p.localNode, p.code, p.reason)
        }
      })
    )
  }
}
