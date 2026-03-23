import { Actions, PeerView, InternalRouteView } from '@catalyst/routing/v2'
import type {
  PeerInfo,
  PeerRecord,
  DataChannelDefinition,
  InternalRoute,
  UpdateMessageSchema,
} from '@catalyst/routing/v2'
import type { z } from 'zod'
import { decodeJwt } from 'jose'
import { getLogger, withWideEvent } from '@catalyst/telemetry'
import type { OrchestratorBus } from './bus.js'

const logger = getLogger(['catalyst', 'orchestrator', 'rpc'])

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

export interface TokenValidator {
  validateToken(
    token: string,
    action: string
  ): Promise<{ valid: true } | { valid: false; error: string }>
}

// ---------------------------------------------------------------------------
// RPC interface definitions — match v1 shapes for backward compatibility,
// with v2 additions (keepalive on IBGPClient).
// ---------------------------------------------------------------------------

export interface NetworkClient {
  addPeer(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
  updatePeer(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
  removePeer(
    peer: Pick<PeerInfo, 'name'>
  ): Promise<{ success: true } | { success: false; error: string }>
  listPeers(): Promise<PeerRecord[]>
}

export interface DataChannel {
  addRoute(
    route: DataChannelDefinition
  ): Promise<{ success: true } | { success: false; error: string }>
  removeRoute(
    route: Pick<DataChannelDefinition, 'name'>
  ): Promise<{ success: true } | { success: false; error: string }>
  listRoutes(): Promise<{ local: DataChannelDefinition[]; internal: InternalRoute[] }>
}

export interface IBGPClient {
  open(data: {
    peerInfo: PeerInfo
    holdTime?: number
  }): Promise<{ success: true } | { success: false; error: string }>
  close(data: {
    peerInfo: PeerInfo
    code: number
    reason?: string
  }): Promise<{ success: true } | { success: false; error: string }>
  update(data: {
    peerInfo: PeerInfo
    update: z.infer<typeof UpdateMessageSchema>
  }): Promise<{ success: true } | { success: false; error: string }>
  keepalive(data: {
    peerInfo: PeerInfo
  }): Promise<{ success: true } | { success: false; error: string }>
}

// ---------------------------------------------------------------------------
// Factory functions — each validates the caller token before returning a
// client. Mirrors the v1 publicApi() pattern where getXxxClient(token)
// gates access behind validateToken().
// ---------------------------------------------------------------------------

export async function createNetworkClient(
  bus: OrchestratorBus,
  token: string,
  validator: TokenValidator
): Promise<{ success: true; client: NetworkClient } | { success: false; error: string }> {
  type Result = { success: true; client: NetworkClient } | { success: false; error: string }
  return withWideEvent('orchestrator.rpc_auth', logger, async (event): Promise<Result> => {
    event.set({
      'catalyst.orchestrator.rpc.client_type': 'NetworkClient',
      'catalyst.orchestrator.rpc.action': 'PEER_CREATE',
    })
    const validation = await validator.validateToken(token, 'PEER_CREATE')
    if (!validation.valid) {
      event.setError(new Error(validation.error))
      return { success: false, error: validation.error }
    }

    return {
      success: true,
      client: {
        async addPeer(peer) {
          const result = await bus.dispatch({ action: Actions.LocalPeerCreate, data: peer })
          return result.success ? { success: true } : { success: false, error: result.error }
        },

        async updatePeer(peer) {
          const result = await bus.dispatch({ action: Actions.LocalPeerUpdate, data: peer })
          return result.success ? { success: true } : { success: false, error: result.error }
        },

        async removePeer(peer) {
          const result = await bus.dispatch({
            action: Actions.LocalPeerDelete,
            data: peer as Pick<PeerInfo, 'name'>,
          })
          return result.success ? { success: true } : { success: false, error: result.error }
        },

        async listPeers() {
          return bus.state.internal.peers.map((p) => new PeerView(p).toPublic())
        },
      },
    }
  })
}

export async function createDataChannelClient(
  bus: OrchestratorBus,
  token: string,
  validator: TokenValidator
): Promise<{ success: true; client: DataChannel } | { success: false; error: string }> {
  type Result = { success: true; client: DataChannel } | { success: false; error: string }
  return withWideEvent('orchestrator.rpc_auth', logger, async (event): Promise<Result> => {
    event.set({
      'catalyst.orchestrator.rpc.client_type': 'DataChannelClient',
      'catalyst.orchestrator.rpc.action': 'ROUTE_CREATE',
    })
    const validation = await validator.validateToken(token, 'ROUTE_CREATE')
    if (!validation.valid) {
      event.setError(new Error(validation.error))
      return { success: false, error: validation.error }
    }

    return {
      success: true,
      client: {
        async addRoute(route) {
          const result = await bus.dispatch({ action: Actions.LocalRouteCreate, data: route })
          return result.success ? { success: true } : { success: false, error: result.error }
        },

        async removeRoute(route) {
          const result = await bus.dispatch({
            action: Actions.LocalRouteDelete,
            data: route as DataChannelDefinition,
          })
          return result.success ? { success: true } : { success: false, error: result.error }
        },

        async listRoutes() {
          return {
            local: bus.state.local.routes,
            internal: bus.state.internal.routes.map((r) => new InternalRouteView(r).toPublic()),
          }
        },
      },
    }
  })
}

/**
 * Extracts the node identity (sub claim) from a peer JWT token.
 * The token has already been verified upstream — this only decodes the payload
 * to bind the iBGP session to the authenticated identity.
 */
function extractPeerIdentity(
  token: string
): { success: true; identity: string } | { success: false; error: string } {
  try {
    const { sub } = decodeJwt(token)
    if (typeof sub !== 'string' || sub.length === 0) {
      return { success: false, error: 'JWT missing sub claim' }
    }
    return { success: true, identity: sub }
  } catch {
    return { success: false, error: 'Failed to decode peer JWT' }
  }
}

/**
 * Creates an iBGP client that binds the session to the authenticated peer
 * identity extracted from the JWT token. Every iBGP method verifies that
 * peerInfo.name matches the JWT sub claim. For update(), additionally
 * verifies that all nodePath[0] entries match the sender identity.
 *
 * This prevents a compromised or malicious peer from impersonating another
 * node by sending messages with a spoofed peerInfo.name or nodePath.
 */
export async function createIBGPClient(
  bus: OrchestratorBus,
  token: string,
  validator: TokenValidator
): Promise<{ success: true; client: IBGPClient } | { success: false; error: string }> {
  type Result = { success: true; client: IBGPClient } | { success: false; error: string }
  return withWideEvent('orchestrator.rpc_auth', logger, async (event): Promise<Result> => {
    event.set({
      'catalyst.orchestrator.rpc.client_type': 'IBGPClient',
      'catalyst.orchestrator.rpc.action': 'IBGP_CONNECT',
    })
    const validation = await validator.validateToken(token, 'IBGP_CONNECT')
    if (!validation.valid) {
      event.setError(new Error(validation.error))
      return { success: false, error: validation.error }
    }

    const identity = extractPeerIdentity(token)
    if (!identity.success) {
      event.setError(new Error(identity.error))
      return { success: false, error: identity.error }
    }

    const peerIdentity = identity.identity

    function verifyPeerName(
      peerInfo: PeerInfo
    ): { success: true } | { success: false; error: string } {
      if (peerInfo.name !== peerIdentity) {
        logger.warn('iBGP identity mismatch: JWT sub={jwtSub} but peerInfo.name={peerName}', {
          'event.name': 'peer.auth.identity_mismatch',
          'catalyst.orchestrator.jwt.sub': peerIdentity,
          'catalyst.orchestrator.peer.name': peerInfo.name,
        })
        return {
          success: false,
          error: 'Peer identity mismatch: peerInfo.name does not match authenticated identity',
        }
      }
      return { success: true }
    }

    return {
      success: true,
      client: {
        async open(data) {
          const check = verifyPeerName(data.peerInfo)
          if (!check.success) return check
          const result = await bus.dispatch({ action: Actions.InternalProtocolOpen, data })
          return result.success ? { success: true } : { success: false, error: result.error }
        },

        async close(data) {
          const check = verifyPeerName(data.peerInfo)
          if (!check.success) return check
          const result = await bus.dispatch({ action: Actions.InternalProtocolClose, data })
          return result.success ? { success: true } : { success: false, error: result.error }
        },

        async update(data) {
          const check = verifyPeerName(data.peerInfo)
          if (!check.success) return check

          // Verify that all route updates have nodePath[0] matching the sender.
          // In single-hop iBGP, the first entry in nodePath must be the originating
          // peer. This prevents route injection with forged origin attribution.
          for (const entry of data.update.updates) {
            if (entry.nodePath.length > 0 && entry.nodePath[0] !== peerIdentity) {
              logger.warn(
                'iBGP nodePath[0] mismatch: JWT sub={jwtSub} but nodePath[0]={nodePath0}',
                {
                  'event.name': 'peer.auth.nodepath_mismatch',
                  'catalyst.orchestrator.jwt.sub': peerIdentity,
                  'route.nodepath_0': entry.nodePath[0],
                }
              )
              return {
                success: false,
                error: 'Route origin mismatch: nodePath[0] does not match authenticated identity',
              }
            }
          }

          const result = await bus.dispatch({ action: Actions.InternalProtocolUpdate, data })
          return result.success ? { success: true } : { success: false, error: result.error }
        },

        async keepalive(data) {
          const check = verifyPeerName(data.peerInfo)
          if (!check.success) return check
          const result = await bus.dispatch({ action: Actions.InternalProtocolKeepalive, data })
          return result.success ? { success: true } : { success: false, error: result.error }
        },
      },
    }
  })
}
