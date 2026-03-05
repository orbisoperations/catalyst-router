import { newWebSocketRpcSession, type RpcStub } from 'capnweb'
import { getLogger } from '@catalyst/telemetry'
import type { PeerRecord } from '@catalyst/routing/v2'
import type { PeerTransport, UpdateMessage } from './transport.js'

/**
 * Remote orchestrator's PublicApi shape — the iBGP RPC interface exposed
 * by every orchestrator node over WebSocket.
 */
interface RemotePublicApi {
  getIBGPClient(token: string): Promise<
    | {
        success: true
        client: {
          open(data: {
            peerInfo: { name: string; domains: string[] }
            holdTime?: number
          }): Promise<{ success: true } | { success: false; error: string }>
          close(data: {
            peerInfo: { name: string; domains: string[] }
            code: number
            reason?: string
          }): Promise<{ success: true } | { success: false; error: string }>
          update(data: {
            peerInfo: { name: string; domains: string[] }
            update: UpdateMessage
          }): Promise<{ success: true } | { success: false; error: string }>
          keepalive(data: {
            peerInfo: { name: string; domains: string[] }
          }): Promise<{ success: true } | { success: false; error: string }>
        }
      }
    | { success: false; error: string }
  >
}

const logger = getLogger(['catalyst', 'orchestrator', 'transport'])

/**
 * WebSocket-based PeerTransport using capnweb RPC sessions.
 *
 * Maintains a pool of WebSocket stubs keyed by endpoint URL.
 * Each call obtains an iBGP client from the remote peer's PublicApi,
 * authenticated with the local node's token.
 */
export class WebSocketPeerTransport implements PeerTransport {
  private readonly stubs = new Map<string, RpcStub<RemotePublicApi>>()
  private readonly localNodeInfo: { name: string; domains: string[] }

  constructor(opts: { localNodeInfo: { name: string; domains: string[] } }) {
    this.localNodeInfo = opts.localNodeInfo
  }

  private requireEndpoint(peer: PeerRecord): string {
    if (!peer.endpoint) {
      throw new Error(`Peer ${peer.name} has no endpoint configured`)
    }
    return peer.endpoint
  }

  private getStub(endpoint: string): RpcStub<RemotePublicApi> {
    let stub = this.stubs.get(endpoint)
    if (stub === undefined) {
      stub = newWebSocketRpcSession<RemotePublicApi>(endpoint)
      this.stubs.set(endpoint, stub)
    }
    return stub
  }

  async openPeer(peer: PeerRecord, token: string): Promise<void> {
    const stub = this.getStub(this.requireEndpoint(peer))
    const result = await stub.getIBGPClient(token)
    if (!result.success) {
      throw new Error(`Failed to get iBGP client for ${peer.name}: ${result.error}`)
    }
    const openResult = await result.client.open({
      peerInfo: this.localNodeInfo,
      holdTime: peer.holdTime,
    })
    if (!openResult.success) {
      throw new Error(`Failed to open peer ${peer.name}: ${openResult.error}`)
    }
    logger.info`Opened connection to ${peer.name}`
  }

  async sendUpdate(peer: PeerRecord, message: UpdateMessage): Promise<void> {
    const stub = this.getStub(this.requireEndpoint(peer))
    const token = peer.peerToken
    if (!token) {
      throw new Error(`No peerToken for ${peer.name} — cannot send update`)
    }
    const result = await stub.getIBGPClient(token)
    if (!result.success) {
      throw new Error(`Failed to get iBGP client for ${peer.name}: ${result.error}`)
    }
    await result.client.update({
      peerInfo: this.localNodeInfo,
      update: message,
    })
  }

  async sendKeepalive(peer: PeerRecord): Promise<void> {
    const stub = this.getStub(this.requireEndpoint(peer))
    const token = peer.peerToken
    if (!token) {
      throw new Error(`No peerToken for ${peer.name} — cannot send keepalive`)
    }
    const result = await stub.getIBGPClient(token)
    if (!result.success) {
      throw new Error(`Failed to get iBGP client for ${peer.name}: ${result.error}`)
    }
    await result.client.keepalive({ peerInfo: this.localNodeInfo })
  }

  async closePeer(peer: PeerRecord, code: number, reason?: string): Promise<void> {
    const endpoint = this.requireEndpoint(peer)
    const stub = this.getStub(endpoint)
    const token = peer.peerToken
    if (!token) {
      logger.warn`No peerToken for ${peer.name} — closing without notification`
      return
    }
    try {
      const result = await stub.getIBGPClient(token)
      if (result.success) {
        await result.client.close({ peerInfo: this.localNodeInfo, code, reason })
      }
    } catch {
      // Best-effort close — if the connection is already down, nothing to do.
    }
    this.stubs.delete(endpoint)
  }
}
