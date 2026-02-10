export interface ServiceUrlConfig {
  /** Explicit URL from user/caller (highest priority) */
  url?: string
  /** Environment variable name to check (second priority) */
  envVar: string
  /** Default port when constructing fallback URL */
  defaultPort: number
  /** Default path (default: '/rpc') */
  defaultPath?: string
  /** Default protocol when URL has none (default: 'ws') */
  defaultProtocol?: string
}

/**
 * Resolve a service URL from explicit value, environment variable, or constructed default.
 *
 * Resolution order: explicit `url` > `process.env[envVar]` > `{protocol}://localhost:{port}{path}`
 *
 * If the resolved URL has no protocol prefix, `defaultProtocol://` is prepended.
 */
export function resolveServiceUrl(config: ServiceUrlConfig): string {
  const raw = config.url ?? process.env[config.envVar]
  if (raw) return ensureProtocol(raw, config.defaultProtocol ?? 'ws')
  const protocol = config.defaultProtocol ?? 'ws'
  const path = config.defaultPath ?? '/rpc'
  return `${protocol}://localhost:${config.defaultPort}${path}`
}

function ensureProtocol(url: string, defaultProtocol: string): string {
  if (/^[a-z]+:\/\//i.test(url)) return url
  return `${defaultProtocol}://${url}`
}
