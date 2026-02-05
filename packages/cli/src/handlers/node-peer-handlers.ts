import { createOrchestratorClient } from '../clients/orchestrator-client.js'
import type { CreatePeerInput, DeletePeerInput, ListPeersInput } from '../types.js'
import type { PeerInfo } from '@catalyst/orchestrator'

export type CreatePeerResult =
  | { success: true; data: { name: string } }
  | { success: false; error: string }

export type ListPeersResult =
  | { success: true; data: { peers: PeerInfo[] } }
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
    const mgmtScope = client.connectionFromManagementSDK()

    const result = await mgmtScope.applyAction({
      resource: 'internalBGPConfig',
      resourceAction: 'create',
      data: {
        name: input.name,
        endpoint: input.endpoint,
        domains: input.domains,
        peerToken: input.peerToken,
      },
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
    const mgmtScope = client.connectionFromManagementSDK()

    const result = await mgmtScope.listPeers()

    return { success: true, data: { peers: result.peers } }
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
    const mgmtScope = client.connectionFromManagementSDK()

    const result = await mgmtScope.deletePeer(input.name)

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
