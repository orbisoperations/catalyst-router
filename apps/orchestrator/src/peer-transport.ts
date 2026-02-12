import type { z } from 'zod'
import type { PeerInfo, PeerRecord, UpdateMessageSchema } from '@catalyst/routing'
import { getLogger } from '@catalyst/telemetry'
import type { ConnectionPool } from './connection-pool.js'
import type { Propagation, UpdateMessage } from './api-types.js'

export type Propagation =
  | { type: 'update'; peer: PeerRecord; localNode: PeerInfo; update: UpdateMessage }
  | { type: 'open'; peer: PeerRecord; localNode: PeerInfo }
  | { type: 'close'; peer: PeerRecord; localNode: PeerInfo; code: number; reason?: string }

export class PeerTransport {
  private readonly logger = getLogger(['catalyst', 'peer-transport'])

  constructor(
    private readonly pool: ConnectionPool,
    private readonly nodeToken?: string
  ) {}

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
    const result = await stub.getIBGPClient(token)
    if (!result.success) {
      this.logger.error`Failed to get iBGP client for ${peer.name}: ${result.error}`
      return
    }
    await result.client.update(localNode, update)
  }

  async sendOpen(peer: PeerRecord, localNode: PeerInfo): Promise<void> {
    const token = this.getToken(peer)
    const stub = this.getStub(peer)
    if (!stub) return
    const result = await stub.getIBGPClient(token)
    if (!result.success) {
      this.logger.error`Failed to get iBGP client for ${peer.name}: ${result.error}`
      return
    }
    const openResult = await result.client.open(localNode)
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
    const result = await stub.getIBGPClient(token)
    if (!result.success) {
      this.logger.error`Failed to get iBGP client for ${peer.name}: ${result.error}`
      return
    }
    await result.client.close(localNode, code, reason)
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
