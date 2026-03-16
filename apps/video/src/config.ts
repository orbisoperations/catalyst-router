import { z } from 'zod'

const PortSchema = z.number().int().min(1).max(65535)

/**
 * Video service configuration schema.
 *
 * Reads ALWAYS fail closed — there is no configurable fail-open for reads.
 * AUTH_FAIL_PUBLISH controls only the publish path. The asymmetry is intentional:
 * an auth outage + fail-open reads = all streams publicly accessible (F-12).
 *
 * MAX_STREAMS (default 100) prevents a localhost attacker from publishing thousands
 * of unique paths, each creating a route + iBGP UPDATE + relay path on every
 * consuming node (F-13).
 *
 * ADVERTISE_ADDRESS exists alongside CATALYST_PEERING_ENDPOINT for NAT/multi-homed
 * scenarios where the peering address isn't the media-reachable address. Same
 * pattern as CATALYST_ENVOY_ADDRESS (R9).
 */
export const VideoConfigSchema = z.object({
  enabled: z.boolean().default(false),
  rtspPort: PortSchema.default(8554),
  rtmpPort: PortSchema.default(1935),
  hlsPort: PortSchema.default(8888),
  apiPort: PortSchema.default(9997),
  metricsPort: PortSchema.default(9998),
  maxStreams: z.number().int().min(1).default(100),
  authFailPublish: z.enum(['closed', 'open']).default('closed'),
  sourceOnDemandStartTimeout: z.string().default('10s'),
  sourceOnDemandCloseAfter: z.string().default('10s'),
  advertiseAddress: z.string().optional(),
  orchestratorEndpoint: z.string(),
  authEndpoint: z.string(),
  systemToken: z.string(),
})

export type VideoConfig = z.infer<typeof VideoConfigSchema>

/**
 * Extract hostname from a URL string, stripping protocol, port, and path.
 * Returns undefined if the URL is malformed or absent.
 */
function extractHostname(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).hostname || undefined
  } catch {
    return undefined
  }
}

/**
 * Load video configuration from environment variables.
 *
 * Falls back to the hostname from CATALYST_PEERING_ENDPOINT for the
 * advertise address when CATALYST_VIDEO_ADVERTISE_ADDRESS is not set.
 */
export function loadVideoConfig(): VideoConfig {
  const advertiseAddress =
    process.env.CATALYST_VIDEO_ADVERTISE_ADDRESS ??
    extractHostname(process.env.CATALYST_PEERING_ENDPOINT)

  return VideoConfigSchema.parse({
    enabled: process.env.CATALYST_VIDEO_ENABLED === 'true',
    rtspPort: process.env.CATALYST_VIDEO_RTSP_PORT
      ? Number(process.env.CATALYST_VIDEO_RTSP_PORT)
      : undefined,
    rtmpPort: process.env.CATALYST_VIDEO_RTMP_PORT
      ? Number(process.env.CATALYST_VIDEO_RTMP_PORT)
      : undefined,
    hlsPort: process.env.CATALYST_VIDEO_HLS_PORT
      ? Number(process.env.CATALYST_VIDEO_HLS_PORT)
      : undefined,
    apiPort: process.env.CATALYST_VIDEO_API_PORT
      ? Number(process.env.CATALYST_VIDEO_API_PORT)
      : undefined,
    metricsPort: process.env.CATALYST_VIDEO_METRICS_PORT
      ? Number(process.env.CATALYST_VIDEO_METRICS_PORT)
      : undefined,
    maxStreams: process.env.CATALYST_VIDEO_MAX_STREAMS
      ? Number(process.env.CATALYST_VIDEO_MAX_STREAMS)
      : undefined,
    authFailPublish: process.env.CATALYST_VIDEO_AUTH_FAIL_PUBLISH ?? undefined,
    sourceOnDemandStartTimeout:
      process.env.CATALYST_VIDEO_SOURCE_ON_DEMAND_START_TIMEOUT ?? undefined,
    sourceOnDemandCloseAfter: process.env.CATALYST_VIDEO_SOURCE_ON_DEMAND_CLOSE_AFTER ?? undefined,
    advertiseAddress,
    orchestratorEndpoint: process.env.CATALYST_ORCHESTRATOR_ENDPOINT,
    authEndpoint: process.env.CATALYST_AUTH_ENDPOINT,
    systemToken: process.env.CATALYST_SYSTEM_TOKEN,
  })
}
