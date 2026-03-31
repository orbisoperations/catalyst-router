import { Actions } from '@catalyst/routing/v2'
import type {
  ActionLog,
  ActionLogEntry,
  PeerInfo,
  PeerRecord,
  DataChannelDefinition,
  InternalRoute,
  UpdateMessageSchema,
} from '@catalyst/routing/v2'
import type { z } from 'zod'
import { decodeJwt } from 'jose'
import { getLogger } from '@catalyst/telemetry'
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

export interface LogClient {
  listEntries(opts?: { afterSeq?: number }): Promise<ActionLogEntry[]>
  getEntry(seq: number): Promise<ActionLogEntry | null>
  lastSeq(): Promise<number>
  verify(): Promise<VerifyResult>
  federatedList(opts?: { afterSeq?: number; limit?: number }): Promise<FederatedListResult>
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
  const validation = await validator.validateToken(token, 'PEER_CREATE')
  if (!validation.valid) {
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
        return bus.state.internal.peers.map(({ peerToken: _, ...rest }) => rest)
      },
    },
  }
}

export async function createDataChannelClient(
  bus: OrchestratorBus,
  token: string,
  validator: TokenValidator
): Promise<{ success: true; client: DataChannel } | { success: false; error: string }> {
  const validation = await validator.validateToken(token, 'ROUTE_CREATE')
  if (!validation.valid) {
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
          internal: bus.state.internal.routes.map((r) => {
            const { peerToken: _, ...safePeer } = r.peer
            return { ...r, peer: safePeer }
          }),
        }
      },
    },
  }
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
  const validation = await validator.validateToken(token, 'IBGP_CONNECT')
  if (!validation.valid) {
    return { success: false, error: validation.error }
  }

  const identity = extractPeerIdentity(token)
  if (!identity.success) {
    return { success: false, error: identity.error }
  }

  const peerIdentity = identity.identity

  function verifyPeerName(
    peerInfo: PeerInfo
  ): { success: true } | { success: false; error: string } {
    if (peerInfo.name !== peerIdentity) {
      logger.warn`iBGP identity mismatch: JWT sub=${peerIdentity} but peerInfo.name=${peerInfo.name}`
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
            logger.warn`iBGP nodePath[0] mismatch: JWT sub=${peerIdentity} but nodePath[0]=${entry.nodePath[0]}`
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
}

// ---------------------------------------------------------------------------
// Log client — read-only access to the action journal.
// ---------------------------------------------------------------------------

/**
 * Field name patterns that indicate sensitive data.
 */
const SENSITIVE_FIELD_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /apikey/i,
  /api_key/i,
  /private_?key/i,
]

function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((p) => p.test(key))
}

function scrubObject(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (isSensitiveField(key)) continue
    if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === 'object' && item !== null
          ? scrubObject(item as Record<string, unknown>)
          : item
      )
    } else if (typeof value === 'object' && value !== null) {
      result[key] = scrubObject(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * Scrub sensitive fields from action log entries before returning to clients.
 * Recursively strips any field matching sensitive patterns.
 */
export function scrubEntry(entry: ActionLogEntry): ActionLogEntry {
  const action = entry.action
  if (!('data' in action) || !action.data || typeof action.data !== 'object') {
    return entry
  }
  const scrubbed = scrubObject(action.data as Record<string, unknown>)
  return { ...entry, action: { ...action, data: scrubbed } as ActionLogEntry['action'] }
}

export type VerifyMismatch = {
  type: 'peer' | 'route'
  name: string
  issue: 'missing_in_journal' | 'missing_in_state' | 'field_mismatch'
  details?: string
}

export type VerifyResult = {
  consistent: boolean
  journalSeq: number
  mismatches: VerifyMismatch[]
}

export type FederatedLogEntry = ActionLogEntry & { sourceNode: string }

export interface FederatedListResult {
  entries: FederatedLogEntry[]
  unreachable: string[]
}

export async function createLogClient(
  actionLog: ActionLog,
  token: string,
  validator: TokenValidator,
  bus?: {
    nodeId: string
    getStateSnapshot: OrchestratorBus['getStateSnapshot']
  }
): Promise<{ success: true; client: LogClient } | { success: false; error: string }> {
  const validation = await validator.validateToken(token, 'LOG_READ')
  if (!validation.valid) {
    return { success: false, error: validation.error }
  }

  return {
    success: true,
    client: {
      async listEntries(opts) {
        const entries = actionLog.replay(opts?.afterSeq)
        return entries.map(scrubEntry)
      },

      async getEntry(seq: number) {
        const entries = actionLog.replay(seq - 1)
        const entry = entries.find((e) => e.seq === seq)
        return entry ? scrubEntry(entry) : null
      },

      async lastSeq() {
        return actionLog.lastSeq()
      },

      async verify(): Promise<VerifyResult> {
        if (!bus) {
          return {
            consistent: false,
            journalSeq: 0,
            mismatches: [
              {
                type: 'peer',
                name: '',
                issue: 'field_mismatch',
                details: 'Verify not available: bus not provided',
              },
            ],
          }
        }

        const journalSeq = actionLog.lastSeq()
        const state = bus.getStateSnapshot()
        const mismatches: VerifyMismatch[] = []

        // Replay journal to reconstruct expected peers and routes
        const allEntries = actionLog.replay()
        const expectedPeers = new Map<string, boolean>()
        const expectedRoutes = new Map<string, boolean>()

        for (const entry of allEntries) {
          const a = entry.action
          if (a.action === 'local:peer:create')
            expectedPeers.set((a.data as { name: string }).name, true)
          if (a.action === 'local:peer:delete')
            expectedPeers.delete((a.data as { name: string }).name)
          if (a.action === 'local:route:create')
            expectedRoutes.set((a.data as { name: string }).name, true)
          if (a.action === 'local:route:delete')
            expectedRoutes.delete((a.data as { name: string }).name)
        }

        // Check peers
        const livePeerNames = new Set(state.local.peers.map((p) => p.name))
        for (const name of expectedPeers.keys()) {
          if (!livePeerNames.has(name)) {
            mismatches.push({ type: 'peer', name, issue: 'missing_in_state' })
          }
        }
        for (const name of livePeerNames) {
          if (!expectedPeers.has(name)) {
            mismatches.push({ type: 'peer', name, issue: 'missing_in_journal' })
          }
        }

        // Check routes
        const liveRouteNames = new Set(state.local.routes.map((r) => r.name))
        for (const name of expectedRoutes.keys()) {
          if (!liveRouteNames.has(name)) {
            mismatches.push({ type: 'route', name, issue: 'missing_in_state' })
          }
        }
        for (const name of liveRouteNames) {
          if (!expectedRoutes.has(name)) {
            mismatches.push({ type: 'route', name, issue: 'missing_in_journal' })
          }
        }

        return { consistent: mismatches.length === 0, journalSeq, mismatches }
      },

      async federatedList(opts) {
        if (!bus) {
          return { entries: [], unreachable: [] }
        }

        const limit = opts?.limit ?? 50
        const localEntries = actionLog.replay(opts?.afterSeq).map(scrubEntry)
        const localTagged: FederatedLogEntry[] = localEntries
          .slice(0, limit)
          .map((e) => ({ ...e, sourceNode: bus.nodeId }))

        // TODO: Add peer fan-out via bus.queryPeerLogs once PeerTransport
        // interface is extended with queryPeerLog (requires transport + mock updates)
        return { entries: localTagged, unreachable: [] }
      },
    },
  }
}
