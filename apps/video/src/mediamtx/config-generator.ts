import type { VideoConfig } from '../config.js'

/**
 * MediaMTX YAML configuration structure.
 *
 * This is the subset of MediaMTX config we control. Fields are mapped 1:1
 * to the top-level YAML keys MediaMTX expects.
 */
export interface MediaMtxConfig {
  logLevel: string
  api: boolean
  apiAddress: string
  metrics: boolean
  metricsAddress: string
  rtsp: boolean
  rtspAddress: string
  rtmp: boolean
  rtmpAddress: string
  hls: boolean
  hlsAddress: string
  srt: boolean
  webrtc: boolean
  pprof: boolean
  record: boolean
  authMethod: string
  authHTTPAddress: string
  authHTTPExclude: Array<{ action: string }>
  pathDefaults: {
    sourceOnDemandStartTimeout: string
    sourceOnDemandCloseAfter: string
    runOnReady: string
    runOnReadyRestart: string
    runOnNotReady: string
    overridePublisher: boolean
  }
}

/**
 * Generate a MediaMTX configuration object from Catalyst video config.
 *
 * Security settings and their rationale:
 *
 * - `srt: false` — SRT streamid is limited to 512 chars (SRT spec section 3.2.1.3);
 *   ES384 JWTs are 800+ chars. Authenticated SRT access is impossible without
 *   a token exchange mechanism. Ref: R10, spec Non-Goals.
 *
 * - `webrtc: false` — Five compounding security issues: STUN leaks node IPs to
 *   Google, TURN has no credential rotation, pprof exposes heap dumps, no TLS
 *   on relay, overridePublisher enables takeover. Ref: spec Non-Goals, F-22.
 *
 * - `pprof: false` — Go pprof exposes heap dumps that can leak in-memory
 *   credentials. Ref: F-16.
 *
 * - `apiAddress: "127.0.0.1:{port}"` — Without localhost binding, any
 *   network-reachable host can create/delete MediaMTX paths, enabling stream
 *   injection and DoS. Ref: F-07.
 *
 * - `record: false` — Path traversal risk via %path in recordPath, disk
 *   management burden with no downstream consumer in v1. Ref: F-11, spec Non-Goals.
 */
export function generateMediaMtxConfig(config: VideoConfig, servicePort: number): MediaMtxConfig {
  const authUrl = `http://127.0.0.1:${servicePort}/video-stream/auth`
  const hookBase = `http://127.0.0.1:${servicePort}/video-stream/hooks`

  return {
    logLevel: 'warn',

    // Control API — localhost-only to prevent unauthorized path manipulation (F-07)
    api: true,
    apiAddress: `127.0.0.1:${config.apiPort}`,

    // Prometheus metrics
    metrics: true,
    metricsAddress: `:${config.metricsPort}`,

    // Protocol listeners
    rtsp: true,
    rtspAddress: `:${config.rtspPort}`,
    rtmp: true,
    rtmpAddress: `:${config.rtmpPort}`,
    hls: true,
    hlsAddress: `:${config.hlsPort}`,

    // SRT disabled — streamid too short for JWT auth (R10, F-22)
    srt: false,
    // WebRTC disabled — STUN/TURN/pprof/TLS security issues (F-22)
    webrtc: false,
    // pprof disabled — heap dumps leak credentials (F-16)
    pprof: false,
    // Recording disabled — path traversal risk, no consumer in v1 (F-11)
    record: false,

    // Auth hook — VideoStreamService validates publish/read via Cedar
    authMethod: 'http',
    authHTTPAddress: authUrl,
    authHTTPExclude: [{ action: 'api' }, { action: 'metrics' }],

    // Path defaults — lifecycle hooks and relay settings
    pathDefaults: {
      sourceOnDemandStartTimeout: config.sourceOnDemandStartTimeout,
      sourceOnDemandCloseAfter: config.sourceOnDemandCloseAfter,
      runOnReady: `curl -sf -X POST -H "Content-Type: application/json" -d '{"path":"$MTX_PATH","sourceType":"$MTX_SOURCE_TYPE","sourceId":"$MTX_SOURCE_ID"}' ${hookBase}/ready`,
      runOnReadyRestart: 'yes',
      runOnNotReady: `curl -sf -X POST -H "Content-Type: application/json" -d '{"path":"$MTX_PATH","sourceType":"$MTX_SOURCE_TYPE","sourceId":"$MTX_SOURCE_ID"}' ${hookBase}/not-ready`,
      overridePublisher: true,
    },
  }
}

/**
 * Serialize a MediaMTX config object to YAML string.
 *
 * Uses a simple serializer to avoid a YAML library dependency. MediaMTX
 * accepts both YAML and JSON, but YAML is the conventional format.
 */
export function serializeMediaMtxConfig(config: MediaMtxConfig): string {
  const lines: string[] = []

  lines.push(`logLevel: ${config.logLevel}`)
  lines.push('')

  lines.push('# Control API — localhost-only to prevent unauthorized path manipulation (F-07)')
  lines.push(`api: ${config.api}`)
  lines.push(`apiAddress: "${config.apiAddress}"`)
  lines.push('')

  lines.push('# Prometheus metrics')
  lines.push(`metrics: ${config.metrics}`)
  lines.push(`metricsAddress: "${config.metricsAddress}"`)
  lines.push('')

  lines.push('# Protocol listeners')
  lines.push(`rtsp: ${config.rtsp}`)
  lines.push(`rtspAddress: "${config.rtspAddress}"`)
  lines.push(`rtmp: ${config.rtmp}`)
  lines.push(`rtmpAddress: "${config.rtmpAddress}"`)
  lines.push(`hls: ${config.hls}`)
  lines.push(`hlsAddress: "${config.hlsAddress}"`)
  lines.push('')

  lines.push('# SRT disabled — streamid too short for JWT auth (R10, F-22)')
  lines.push(`srt: ${config.srt}`)
  lines.push('# WebRTC disabled — STUN/TURN/pprof/TLS security issues (F-22)')
  lines.push(`webrtc: ${config.webrtc}`)
  lines.push('# pprof disabled — heap dumps leak credentials (F-16)')
  lines.push(`pprof: ${config.pprof}`)
  lines.push('# Recording disabled — path traversal risk, no consumer in v1 (F-11)')
  lines.push(`record: ${config.record}`)
  lines.push('')

  lines.push('# Auth hook')
  lines.push(`authMethod: ${config.authMethod}`)
  lines.push(`authHTTPAddress: "${config.authHTTPAddress}"`)
  lines.push('authHTTPExclude:')
  for (const exclude of config.authHTTPExclude) {
    lines.push(`  - action: ${exclude.action}`)
  }
  lines.push('')

  lines.push('# Path defaults')
  lines.push('pathDefaults:')
  lines.push(`  sourceOnDemandStartTimeout: ${config.pathDefaults.sourceOnDemandStartTimeout}`)
  lines.push(`  sourceOnDemandCloseAfter: ${config.pathDefaults.sourceOnDemandCloseAfter}`)
  lines.push(`  runOnReady: "${escapeYaml(config.pathDefaults.runOnReady)}"`)
  lines.push(`  runOnReadyRestart: ${config.pathDefaults.runOnReadyRestart}`)
  lines.push(`  runOnNotReady: "${escapeYaml(config.pathDefaults.runOnNotReady)}"`)
  lines.push(`  overridePublisher: ${config.pathDefaults.overridePublisher}`)
  lines.push('')

  // Default path — accept any stream name (auth hook controls access)
  lines.push('paths:')
  lines.push('  all_others:')
  lines.push('')

  return lines.join('\n')
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
