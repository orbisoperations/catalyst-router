import { createOrchestratorClient } from '../clients/orchestrator-client.js'
import type { CreatePeerInput, DeletePeerInput, ListPeersInput } from '../types.js'
import type { PeerRecord } from '@catalyst/routing'

export type CreatePeerResult =
  | { success: true; data: { name: string } }
  | { success: false; error: string }

export type ListPeersResult =
  | { success: true; data: { peers: PeerRecord[] } }
  | { success: false; error: string }

export type DeletePeerResult =
  | { success: true; data: { name: string } }
  | { success: false; error: string }

/**
 * Create a new peer connection
 */
export async function createPeerHandler(input: CreatePeerInput): Promise<CreatePeerResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const netResult = await client.getNetworkClient(input.token || '')

    if (!netResult.success) {
      return { success: false, error: netResult.error }
    }

    const result = await netResult.client.addPeer({
      name: input.name,
      endpoint: input.endpoint,
      domains: input.domains,
      peerToken: input.peerToken,
    })

    if (result.success) {
      return { success: true, data: { name: input.name } }
    } else {
      return { success: false, error: result.error || 'Unknown error' }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * List all peer connections
 */
export async function listPeersHandler(input: ListPeersInput): Promise<ListPeersResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const netResult = await client.getNetworkClient(input.token || '')

    if (!netResult.success) {
      return { success: false, error: netResult.error }
    }

    const peers = await netResult.client.listPeers()

    return { success: true, data: { peers } }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Delete a peer connection
 */
export async function deletePeerHandler(input: DeletePeerInput): Promise<DeletePeerResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const netResult = await client.getNetworkClient(input.token || '')

    if (!netResult.success) {
      return { success: false, error: netResult.error }
    }

    const result = await netResult.client.removePeer({ name: input.name })

    if (result.success) {
      return { success: true, data: { name: input.name } }
    } else {
      return { success: false, error: result.error || 'Unknown error' }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
