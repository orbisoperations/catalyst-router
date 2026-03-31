/**
 * Thin action wrappers for the simulator.
 * Calls the RPC client methods directly — same path the real CLI uses.
 */
import { createOrchestratorClient } from '../clients/orchestrator-client.js'

export interface SimulatorContext {
  orchestratorUrl?: string
  token: string
}

export async function simCreatePeer(
  ctx: SimulatorContext,
  name: string,
  endpoint: string,
  domains: string[] = [],
  peerToken?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const client = await createOrchestratorClient(ctx.orchestratorUrl)
    const netResult = await client.getNetworkClient(ctx.token)
    if (!netResult.success) return { success: false, error: netResult.error }

    const result = await netResult.client.addPeer({
      name,
      endpoint,
      domains,
      peerToken: peerToken ?? `tok-${name}`,
    })
    return result
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function simDeletePeer(
  ctx: SimulatorContext,
  name: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const client = await createOrchestratorClient(ctx.orchestratorUrl)
    const netResult = await client.getNetworkClient(ctx.token)
    if (!netResult.success) return { success: false, error: netResult.error }

    const result = await netResult.client.removePeer({ name })
    return result
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function simCreateRoute(
  ctx: SimulatorContext,
  name: string,
  endpoint: string,
  protocol: 'http' | 'http:graphql' | 'http:gql' | 'http:grpc' | 'tcp' = 'http:graphql'
): Promise<{ success: boolean; error?: string }> {
  try {
    const client = await createOrchestratorClient(ctx.orchestratorUrl)
    const dcResult = await client.getDataChannelClient(ctx.token)
    if (!dcResult.success) return { success: false, error: dcResult.error }

    const result = await dcResult.client.addRoute({ name, endpoint, protocol })
    return result
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function simDeleteRoute(
  ctx: SimulatorContext,
  name: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const client = await createOrchestratorClient(ctx.orchestratorUrl)
    const dcResult = await client.getDataChannelClient(ctx.token)
    if (!dcResult.success) return { success: false, error: dcResult.error }

    const result = await dcResult.client.removeRoute({ name })
    return result
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
