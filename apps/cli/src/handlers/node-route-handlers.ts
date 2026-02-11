import { createOrchestratorClient } from '../clients/orchestrator-client.js'
import type { CreateRouteInput, DeleteRouteInput, ListRoutesInput } from '../types.js'
import type { DataChannelDefinition, InternalRoute } from '@catalyst/routing'

export type CreateRouteResult =
  | { success: true; data: { name: string } }
  | { success: false; error: string }

export type ListRoutesResult =
  | {
      success: true
      data: {
        routes: Array<
          | (DataChannelDefinition & { source: 'local' })
          | (InternalRoute & { source: 'internal'; peer: string })
        >
      }
    }
  | { success: false; error: string }

export type DeleteRouteResult =
  | { success: true; data: { name: string } }
  | { success: false; error: string }

/**
 * Create a new local route
 */
export async function createRouteHandler(input: CreateRouteInput): Promise<CreateRouteResult> {
  try {
    const token = input.token || ''
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const dataChannelResult = await client.getDataChannelClient(token)

    if (!dataChannelResult.success) {
      return { success: false, error: dataChannelResult.error }
    }

    const result = await dataChannelResult.client.addRoute({
      name: input.name,
      endpoint: input.endpoint,
      protocol: input.protocol,
      region: input.region,
      tags: input.tags,
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
 * List all routes (local and internal)
 */
export async function listRoutesHandler(input: ListRoutesInput): Promise<ListRoutesResult> {
  try {
    const token = input.token || ''
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const dataChannelResult = await client.getDataChannelClient(token)

    if (!dataChannelResult.success) {
      return { success: false, error: dataChannelResult.error }
    }

    const result = await dataChannelResult.client.listRoutes()
    const allRoutes = [
      ...result.local.map((r) => ({ ...r, source: 'local' as const })),
      ...result.internal.map((r) => ({
        ...r,
        source: 'internal' as const,
        peer: r.peerName,
      })),
    ]

    return { success: true, data: { routes: allRoutes } }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Delete a local route
 */
export async function deleteRouteHandler(input: DeleteRouteInput): Promise<DeleteRouteResult> {
  try {
    const token = input.token || ''
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const dataChannelResult = await client.getDataChannelClient(token)

    if (!dataChannelResult.success) {
      return { success: false, error: dataChannelResult.error }
    }

    const result = await dataChannelResult.client.removeRoute({
      name: input.name,
      protocol: 'http', // Default protocol for delete by name
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
