/**
 * IBGPProtocolHandler - Handles incoming iBGP protocol messages.
 * Responsibilities: open/close/update/keepAlive protocol actions
 */

import { BasePlugin } from '../base.js'
import type { PluginContext, PluginResult } from '../types.js'
import { getConfig } from '../../config.js'
import type { RouteTable } from '../../state/route-table.js'
import {
  IBGPProtocolOpenSchema,
  IBGPProtocolCloseSchema,
  IBGPProtocolUpdateSchema,
  IBGPProtocolKeepAliveSchema,
  IBGPProtocolResource,
  IBGPProtocolResourceAction,
} from '../../rpc/schema/peering.js'
import type { SessionFactory } from './ibgp-shared.js'
import { getMyPeerInfo, parseError, buildRouteUpdates } from './ibgp-shared.js'
import { getHttpPeerSession } from '../../rpc/client.js'
import { withTimeout, getRpcTimeout } from '../../utils/timeout.js'

export class IBGPProtocolHandler extends BasePlugin {
  name = 'IBGPProtocolHandler'
  private stateProvider?: () => RouteTable

  constructor(private readonly sessionFactory: SessionFactory = getHttpPeerSession) {
    super()
  }

  async apply(context: PluginContext): Promise<PluginResult> {
    const { action } = context
    if (action.resource !== IBGPProtocolResource.value) return { success: true, ctx: context }

    let result: PluginResult
    switch (action.resourceAction) {
      case IBGPProtocolResourceAction.enum.open:
        result = await this.handleOpen(context)
        break
      case IBGPProtocolResourceAction.enum.close:
        result = await this.handleClose(context)
        break
      case IBGPProtocolResourceAction.enum.update:
        result = await this.handleUpdate(context)
        break
      case IBGPProtocolResourceAction.enum.keepAlive:
        result = await this.handleKeepAlive(context)
        break
      default:
        return { success: true, ctx: context }
    }

    if (result.success) this.stateProvider = () => result.ctx.state
    return result
  }

  private async handleOpen(context: PluginContext): Promise<PluginResult> {
    const result = IBGPProtocolOpenSchema.safeParse(context.action)
    if (!result.success)
      return parseError(this.name, 'Invalid iBGP open action', context, result.error)

    const { peerInfo } = result.data.data
    console.log(`[IBGPProtocolHandler] Handling OPEN from ${peerInfo.id}`)

    let newState = context.state
    const existingByEndpoint = newState.getPeers().find((p) => p.endpoint === peerInfo.endpoint)

    // Unify peer ID if endpoint matches but ID differs
    if (existingByEndpoint && existingByEndpoint.id !== peerInfo.id) {
      console.log(
        `[IBGPProtocolHandler] Unifying peer ID: ${existingByEndpoint.id} -> ${peerInfo.id}`
      )
      newState = newState.removePeer(existingByEndpoint.id)
    }

    // Skip if peer already registered (prevents infinite loops)
    if (newState.getPeer(peerInfo.id)) {
      console.log(`[IBGPProtocolHandler] Peer ${peerInfo.id} already exists.`)
      return { success: true, ctx: { ...context, state: newState } }
    }

    const { state: updatedState } = newState.addPeer({
      id: peerInfo.id,
      as: peerInfo.as,
      endpoint: peerInfo.endpoint || 'unknown',
      domains: peerInfo.domains || [],
    })
    console.log(`[IBGPProtocolHandler] Peer ${peerInfo.id} registered.`)

    // Background sync to avoid blocking OPEN response
    // IMPORTANT: Capture updatedState directly to avoid stale state race condition
    // (this.stateProvider isn't updated until after apply() returns)
    const stateForSync = updatedState
    setImmediate(async () => {
      try {
        const config = getConfig()
        const timeout = getRpcTimeout()
        const ibgpScope = this.sessionFactory(peerInfo.endpoint, config.ibgp.secret)

        const openResult = await withTimeout(
          ibgpScope.open(getMyPeerInfo()),
          timeout,
          `Reverse OPEN to ${peerInfo.endpoint}`
        )
        if (!openResult.success) {
          console.warn(`[IBGPProtocolHandler] Reverse OPEN failed: ${openResult.error}`)
          return
        }

        const updates = buildRouteUpdates(stateForSync)
        if (updates.length > 0) {
          await withTimeout(
            ibgpScope.update(getMyPeerInfo(), updates),
            timeout,
            `Route sync to ${peerInfo.endpoint}`
          )
        }
      } catch (e: any) {
        console.error(`[IBGPProtocolHandler] Background sync failed for ${peerInfo.id}:`, e.message)
      }
    })

    return { success: true, ctx: { ...context, state: updatedState } }
  }

  private async handleClose(context: PluginContext): Promise<PluginResult> {
    const result = IBGPProtocolCloseSchema.safeParse(context.action)
    if (!result.success)
      return parseError(this.name, 'Invalid iBGP close action', context, result.error)

    const { peerInfo } = result.data.data
    console.log(`[IBGPProtocolHandler] Handling CLOSE for ${peerInfo.id}`)
    return { success: true, ctx: { ...context, state: context.state.removePeer(peerInfo.id) } }
  }

  private async handleKeepAlive(context: PluginContext): Promise<PluginResult> {
    const result = IBGPProtocolKeepAliveSchema.safeParse(context.action)
    if (!result.success)
      return parseError(this.name, 'Invalid iBGP keepalive action', context, result.error)
    return { success: true, ctx: context }
  }

  private async handleUpdate(context: PluginContext): Promise<PluginResult> {
    const result = IBGPProtocolUpdateSchema.safeParse(context.action)
    if (!result.success)
      return parseError(this.name, 'Invalid iBGP update action', context, result.error)

    const { peerInfo, updateMessages } = result.data.data
    const myAs = getConfig().as
    console.log(
      `[IBGPProtocolHandler] UPDATE from ${peerInfo.id} with ${updateMessages.length} messages`
    )

    let newState = context.state
    const routesToPropagate: { route: any; asPath: number[] }[] = []

    for (const msg of updateMessages) {
      if (msg.type === 'add') {
        const asPath = msg.asPath || []
        if (asPath.includes(myAs)) {
          console.warn(`[IBGPProtocolHandler] Loop detected for ${msg.route.name}. Dropping.`)
          continue
        }
        const res = newState.addInternalRoute(msg.route, peerInfo.id, asPath)
        newState = res.state
        routesToPropagate.push({ route: msg.route, asPath })
      } else if (msg.type === 'remove') {
        newState = newState.removeRoute(msg.routeId)
      }
    }

    console.log(`[IBGPProtocolHandler] Routes updated. Total: ${newState.getRoutes().length}`)
    const updatedContext = { ...context, state: newState }

    // Propagate to other peers
    if (routesToPropagate.length > 0) {
      const peers = newState.getPeers().filter((p) => p.id !== peerInfo.id)
      console.log(
        `[IBGPProtocolHandler] Propagating ${routesToPropagate.length} routes to ${peers.length} peers.`
      )

      const promises: Promise<any>[] = []
      for (const peer of peers) {
        for (const item of routesToPropagate) {
          promises.push(
            this.sendUpdate(updatedContext, peer.id, {
              type: 'add',
              route: item.route,
              asPath: [myAs, ...item.asPath],
            })
          )
        }
      }

      const results = await Promise.all(promises)
      const failure = results.find((r) => !r.success)
      if (failure)
        return parseError(this.name, `Propagation failed: ${failure.error}`, updatedContext)
    }

    return { success: true, ctx: updatedContext }
  }

  private async sendUpdate(
    context: PluginContext,
    peerId: string,
    msg: { type: 'add'; route: any; asPath: number[] }
  ): Promise<{ success: boolean; error?: string }> {
    const peer = context.state.getPeer(peerId)
    if (!peer?.endpoint || peer.endpoint === 'unknown') return { success: true }

    try {
      const config = getConfig()
      const ibgpScope = this.sessionFactory(peer.endpoint, config.ibgp.secret)
      return await withTimeout(
        ibgpScope.update(getMyPeerInfo(), [msg]),
        getRpcTimeout(),
        `UPDATE to ${peer.endpoint}`
      )
    } catch (e: any) {
      console.error(`[IBGPProtocolHandler] Failed update to ${peerId}:`, e.message)
      return { success: false, error: e.message }
    }
  }
}
