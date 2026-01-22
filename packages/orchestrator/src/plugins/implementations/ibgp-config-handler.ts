/**
 * IBGPConfigHandler - Handles admin/config operations for iBGP peers.
 * Responsibilities: create/update/delete peer actions
 */

import { BasePlugin } from '../base.js'
import type { PluginContext, PluginResult } from '../types.js'
import { getConfig } from '../../config.js'
import { withTimeout, getRpcTimeout } from '../../utils/timeout.js'
import {
  IBGPConfigCreatePeerSchema,
  IBGPConfigUpdatePeerSchema,
  IBGPConfigDeletePeerSchema,
  IBGPConfigResource,
  IBGPConfigResourceAction,
} from '../../rpc/schema/peering.js'
import type { SessionFactory } from './ibgp-shared.js'
import { getMyPeerInfo, parseError, buildRouteUpdates } from './ibgp-shared.js'
import { getHttpPeerSession } from '../../rpc/client.js'

export class IBGPConfigHandler extends BasePlugin {
  name = 'IBGPConfigHandler'

  constructor(private readonly sessionFactory: SessionFactory = getHttpPeerSession) {
    super()
  }

  async apply(context: PluginContext): Promise<PluginResult> {
    const { action } = context
    if (action.resource !== IBGPConfigResource.value) return { success: true, ctx: context }

    switch (action.resourceAction) {
      case IBGPConfigResourceAction.enum.create:
        return this.handleCreate(context)
      case IBGPConfigResourceAction.enum.update:
        return this.handleUpdate(context)
      case IBGPConfigResourceAction.enum.delete:
        return this.handleDelete(context)
      default:
        return { success: true, ctx: context }
    }
  }

  private async handleCreate(context: PluginContext): Promise<PluginResult> {
    const result = IBGPConfigCreatePeerSchema.safeParse(context.action)
    if (!result.success)
      return parseError(this.name, 'Invalid iBGP create peer action', context, result.error)

    const { endpoint } = result.data.data
    if (context.state.getPeers().some((p) => p.endpoint === endpoint)) {
      console.log(`[IBGPConfigHandler] Peer at ${endpoint} already exists. Skipping.`)
      return { success: true, ctx: context }
    }

    console.log(`[IBGPConfigHandler] Handshaking with peer at ${endpoint}...`)
    const config = getConfig()

    try {
      const ibgpScope = this.sessionFactory(endpoint, config.ibgp.secret)
      const myPeerInfo = getMyPeerInfo()
      const timeout = getRpcTimeout()

      const openPromise = withTimeout(ibgpScope.open(myPeerInfo), timeout, `OPEN to ${endpoint}`)
      const updates = buildRouteUpdates(context.state)
      const updatePromise =
        updates.length > 0
          ? withTimeout(ibgpScope.update(myPeerInfo, updates), timeout, `UPDATE to ${endpoint}`)
          : Promise.resolve()

      const [openResult] = await Promise.all([openPromise, updatePromise])
      if (!openResult.success) throw new Error(openResult.error || 'Peer rejected OPEN')

      const { state: newState } = context.state.addPeer(openResult.peerInfo)
      console.log(`[IBGPConfigHandler] Peer ${openResult.peerInfo.id} added after handshake.`)
      return { success: true, ctx: { ...context, state: newState } }
    } catch (e: any) {
      console.error(`[IBGPConfigHandler] Failed handshake with ${endpoint}:`, e.message)
      return parseError(this.name, `Failed to handshake with peer: ${e.message}`, context)
    }
  }

  private async handleUpdate(context: PluginContext): Promise<PluginResult> {
    const result = IBGPConfigUpdatePeerSchema.safeParse(context.action)
    if (!result.success)
      return parseError(this.name, 'Invalid iBGP update peer action', context, result.error)

    const { peerId, endpoint, domains } = result.data.data
    const peer = context.state.getPeer(peerId)
    if (!peer) return parseError(this.name, `Peer ${peerId} not found for update`, context)

    console.log(`[IBGPConfigHandler] Updating peer ${peerId} to ${endpoint}`)
    const config = getConfig()
    const myPeerInfo = getMyPeerInfo()
    const timeout = getRpcTimeout()

    try {
      // Close old connection if exists
      if (peer.endpoint && peer.endpoint !== 'unknown') {
        try {
          const oldScope = this.sessionFactory(peer.endpoint, config.ibgp.secret)
          await withTimeout(oldScope.close(myPeerInfo), timeout, `CLOSE to ${peer.endpoint}`)
        } catch (e: any) {
          console.warn(`[IBGPConfigHandler] Failed to close old connection:`, e.message)
        }
      }

      // Open new connection with route sync
      const ibgpScope = this.sessionFactory(endpoint, config.ibgp.secret)
      const openPromise = withTimeout(ibgpScope.open(myPeerInfo), timeout, `OPEN to ${endpoint}`)
      const updates = buildRouteUpdates(context.state)
      const updatePromise =
        updates.length > 0
          ? withTimeout(ibgpScope.update(myPeerInfo, updates), timeout, `UPDATE to ${endpoint}`)
          : Promise.resolve()

      const [openResult] = await Promise.all([openPromise, updatePromise])
      if (!openResult.success) throw new Error(openResult.error || 'Peer rejected OPEN')

      const updatedPeer = { ...peer, endpoint, domains: domains ?? peer.domains }
      const { state: newState } = context.state.addPeer(updatedPeer)
      return { success: true, ctx: { ...context, state: newState } }
    } catch (e: any) {
      console.error(`[IBGPConfigHandler] Failed update handshake with ${endpoint}:`, e.message)
      return parseError(this.name, `Failed to handshake with new endpoint: ${e.message}`, context)
    }
  }

  private async handleDelete(context: PluginContext): Promise<PluginResult> {
    const result = IBGPConfigDeletePeerSchema.safeParse(context.action)
    if (!result.success)
      return parseError(this.name, 'Invalid iBGP delete peer action', context, result.error)

    const { peerId } = result.data.data
    const peer = context.state.getPeer(peerId)
    if (!peer) return { success: true, ctx: context }

    console.log(`[IBGPConfigHandler] Deleting peer ${peerId}`)
    const config = getConfig()
    const timeout = getRpcTimeout()

    if (peer.endpoint && peer.endpoint !== 'unknown') {
      try {
        const ibgpScope = this.sessionFactory(peer.endpoint, config.ibgp.secret)
        await withTimeout(ibgpScope.close(getMyPeerInfo()), timeout, `CLOSE to ${peer.endpoint}`)
      } catch (e: any) {
        console.warn(`[IBGPConfigHandler] Failed to send CLOSE:`, e.message)
      }
    }

    const newState = context.state.removePeer(peerId)
    return { success: true, ctx: { ...context, state: newState } }
  }
}
