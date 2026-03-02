import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { VideoConfig } from '@catalyst/config'

export function generateMediaMTXConfig(config: VideoConfig, servicePort: number): string {
  const hookBase = `http://localhost:${servicePort}/video-stream/hooks`
  const readyCmd = `curl -s -X POST -H "Content-Type: application/json" -d '{"path":"$MTX_PATH","sourceType":"$MTX_SOURCE_TYPE"}' ${hookBase}/ready`
  const notReadyCmd = `curl -s -X POST -H "Content-Type: application/json" -d '{"path":"$MTX_PATH"}' ${hookBase}/not-ready`

  const cfg = {
    api: true,
    apiAddress: ':9997',
    rtsp: true,
    rtspAddress: `:${config.rtspPort}`,
    srt: true,
    srtAddress: `:${config.srtPort}`,
    hls: true,
    hlsAddress: `:${config.hlsPort}`,
    webrtc: true,
    webrtcAddress: `:${config.webrtcPort}`,
    authHTTPAddress: `http://localhost:${servicePort}/video-stream/auth`,
    pathDefaults: {
      runOnReady: readyCmd,
      runOnNotReady: notReadyCmd,
    },
  }

  // Use JSON.stringify + simple transform for safe YAML generation.
  // This avoids YAML quoting pitfalls with embedded shell commands.
  return jsonToYaml(cfg)
}

/** Minimal JSON-to-YAML serializer for flat/shallow configs. */
function jsonToYaml(obj: Record<string, unknown>, indent = 0): string {
  const pad = '  '.repeat(indent)
  let out = ''
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out += `${pad}${key}:\n`
      out += jsonToYaml(value as Record<string, unknown>, indent + 1)
    } else if (typeof value === 'string') {
      // Quote strings that contain characters problematic for YAML
      if (/[:{}'"\n#]/.test(value)) {
        // Use double quotes, escaping inner double quotes
        out += `${pad}${key}: "${value.replace(/"/g, '\\"')}"\n`
      } else {
        out += `${pad}${key}: ${value}\n`
      }
    } else {
      out += `${pad}${key}: ${value}\n`
    }
  }
  return out
}

export function writeMediaMTXConfig(yamlContent: string, filename = 'mediamtx.yaml'): string {
  const configPath = join(tmpdir(), filename)
  writeFileSync(configPath, yamlContent, 'utf-8')
  return configPath
}
