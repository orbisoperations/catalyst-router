import { createVideoClient } from '../clients/video-client.js'
import type { HealthCheckInput } from '../types.js'

export type HealthCheckResult =
  | { success: true; data: { status: string; ready: boolean; catalog: boolean } }
  | { success: false; error: string }

export async function healthCheckHandler(input: HealthCheckInput): Promise<HealthCheckResult> {
  try {
    const client = createVideoClient(input.videoUrl)
    const [health, readiness] = await Promise.all([client.health(), client.ready()])
    return {
      success: true,
      data: {
        status: health.status,
        ready: readiness.ready,
        catalog: readiness.catalog,
      },
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
