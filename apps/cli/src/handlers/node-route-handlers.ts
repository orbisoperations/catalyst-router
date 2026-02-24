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
          (DataChannelDefinition & { source: 'local' }) | (InternalRoute & { source: 'internal' })
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
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const dcResult = await client.getDataChannelClient(input.token || '')

    if (!dcResult.success) {
      return { success: false, error: dcResult.error }
    }

    const result = await dcResult.client.addRoute({
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
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const dcResult = await client.getDataChannelClient(input.token || '')

    if (!dcResult.success) {
      return { success: false, error: dcResult.error }
    }

    const routes = await dcResult.client.listRoutes()
    const allRoutes = [
      ...routes.local.map((r) => ({ ...r, source: 'local' as const })),
      ...routes.internal.map((r) => ({
        ...r,
        source: 'internal' as const,
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
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const dcResult = await client.getDataChannelClient(input.token || '')

    if (!dcResult.success) {
      return { success: false, error: dcResult.error }
    }

    const result = await dcResult.client.removeRoute({
      name: input.name,
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
