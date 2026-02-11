import type { PeerRecord } from '@catalyst/routing'
import { createOrchestratorClient } from '../clients/orchestrator-client.js'
import type { CreatePeerInput, DeletePeerInput, ListPeersInput } from '../types.js'

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
    const token = input.token || ''
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const networkResult = await client.getNetworkClient(token)

    if (!networkResult.success) {
      return { success: false, error: networkResult.error }
    }

    const result = await networkResult.client.addPeer({
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
    const token = input.token || ''
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const networkResult = await client.getNetworkClient(token)

    if (!networkResult.success) {
      return { success: false, error: networkResult.error }
    }

    const peers = await networkResult.client.listPeers()
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
    const token = input.token || ''
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const networkResult = await client.getNetworkClient(token)

    if (!networkResult.success) {
      return { success: false, error: networkResult.error }
    }

    const result = await networkResult.client.removePeer({ name: input.name })

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
