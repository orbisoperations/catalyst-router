import { newHttpBatchRpcSession, type RpcStub } from 'capnweb'
import { getLogger, WideEvent } from '@catalyst/telemetry'
import type { PeerRecord } from '@catalyst/routing/v2'
import type { PeerTransport, UpdateMessage } from './transport.js'

/**
 * Remote orchestrator's PublicApi shape — the iBGP RPC interface exposed
 * by every orchestrator node over HTTP batch RPC.
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

const logger = getLogger(['catalyst', 'orchestrator', 'transport', 'http'])

/**
 * HTTP batch RPC PeerTransport using capnweb HTTP sessions.
 *
 * Maintains a pool of HTTP stubs keyed by endpoint URL.
 * Suitable for environments where persistent WebSocket connections are
 * not available or desired (e.g. behind HTTP-only load balancers).
 *
 * Same interface as WebSocketPeerTransport — can be swapped via config.
 */
export class HttpPeerTransport implements PeerTransport {
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
      stub = newHttpBatchRpcSession<RemotePublicApi>(endpoint)
      this.stubs.set(endpoint, stub)
    }
    return stub
  }

  async openPeer(peer: PeerRecord, token: string): Promise<void> {
    const event = new WideEvent('transport.open_peer', logger)
    event.set({
      'catalyst.orchestrator.peer.name': peer.name,
      'catalyst.orchestrator.peer.endpoint': peer.endpoint,
      'catalyst.orchestrator.transport.type': 'http',
    })
    const stub = this.getStub(this.requireEndpoint(peer))
    const result = await stub.getIBGPClient(token)
    if (!result.success) {
      const err = new Error(`Failed to get iBGP client for ${peer.name}: ${result.error}`)
      event.setError(err)
      event.emit()
      throw err
    }
    const openResult = await result.client.open({
      peerInfo: this.localNodeInfo,
      holdTime: peer.holdTime,
    })
    if (!openResult.success) {
      const err = new Error(`Failed to open peer ${peer.name}: ${openResult.error}`)
      event.setError(err)
      event.emit()
      throw err
    }
    event.emit()
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
    const updateResult = await result.client.update({
      peerInfo: this.localNodeInfo,
      update: message,
    })
    if (!updateResult.success) {
      throw new Error(`Failed to send update to ${peer.name}: ${updateResult.error}`)
    }
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
    const keepaliveResult = await result.client.keepalive({ peerInfo: this.localNodeInfo })
    if (!keepaliveResult.success) {
      throw new Error(`Failed to send keepalive to ${peer.name}: ${keepaliveResult.error}`)
    }
  }

  async closePeer(peer: PeerRecord, code: number, reason?: string): Promise<void> {
    const event = new WideEvent('transport.close_peer', logger)
    event.set({
      'catalyst.orchestrator.peer.name': peer.name,
      'catalyst.orchestrator.transport.close_code': code,
      'catalyst.orchestrator.transport.close_reason': reason,
    })
    const endpoint = this.requireEndpoint(peer)
    const stub = this.getStub(endpoint)
    const token = peer.peerToken
    if (!token) {
      event.set('catalyst.orchestrator.transport.close_skipped', true)
      event.emit()
      return
    }
    try {
      const result = await stub.getIBGPClient(token)
      if (result.success) {
        const closeResult = await result.client.close({
          peerInfo: this.localNodeInfo,
          code,
          reason,
        })
        if (!closeResult.success) {
          event.setError(new Error(closeResult.error))
        }
      }
    } catch {
      // Best-effort close — if the connection is already down, nothing to do.
    }
    event.emit()
    this.stubs.delete(endpoint)
  }
}
