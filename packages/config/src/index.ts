import { readFileSync } from 'node:fs'
import { z } from 'zod'

/**
 * Port entry: either a single port number or a [start, end] range tuple.
 */
const PortNumberSchema = z.number().int().min(1).max(65535)

export const PortEntrySchema = z.union([
  PortNumberSchema,
  z
    .tuple([PortNumberSchema, PortNumberSchema])
    .refine(([start, end]) => start <= end, 'Start must be <= end'),
])

export type PortEntry = z.infer<typeof PortEntrySchema>

/**
 * Envoy proxy configuration.
 */
export const EnvoyConfigSchema = z.object({
  adminPort: PortNumberSchema.default(9901),
  xdsPort: PortNumberSchema.default(18000),
  bindAddress: z.string().default('0.0.0.0'),
})

export type EnvoyConfig = z.infer<typeof EnvoyConfigSchema>

/**
 * Shared Node Identity Schema
 */
export const NodeConfigSchema = z.object({
  name: z.string(),
  domains: z.array(z.string()),
  endpoint: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  peerToken: z.string().optional(), // Token to use when connecting to this peer
  envoyAddress: z.string().optional(), // Reachable address of this node's Envoy proxy
})

export type NodeConfig = z.infer<typeof NodeConfigSchema>

/**
 * Orchestrator Specific Configuration
 */
export const OrchestratorConfigSchema = z.object({
  gqlGatewayConfig: z
    .object({
      endpoint: z.string(),
    })
    .optional(),
  auth: z
    .object({
      endpoint: z.string(),
      systemToken: z.string(),
    })
    .optional(),
  envoyConfig: z
    .object({
      endpoint: z.string(),
      envoyAddress: z.string().optional(),
      portRange: z.array(PortEntrySchema).min(1),
    })
    .optional(),
  /**
   * When true, allow all operations when no auth service is configured.
   * Defaults to false (fail-closed). Only use in development/testing.
   */
  allowNoAuth: z.boolean().default(false),
  /**
   * Journal configuration for action log persistence and compaction.
   *
   * Modes:
   * - "memory" (default): In-memory journal, no persistence. For dev/testing.
   * - "sqlite": SQLite-backed journal with periodic snapshot + truncate compaction.
   *
   * Example (production):
   * ```json
   * { "mode": "sqlite", "path": "/data/journal.db" }
   * ```
   */
  journal: z
    .object({
      /** "sqlite" for persistent storage, "memory" for ephemeral (default). */
      mode: z.enum(['sqlite', 'memory']).default('memory'),
      /** SQLite file path. Required when mode is "sqlite". */
      path: z.string().optional(),
      /** Compaction interval in milliseconds. Default: 24 hours. 0 disables compaction. */
      compactionIntervalMs: z.number().min(0).default(86_400_000),
      /** Minimum journal entries accumulated before compaction triggers. Default: 1000. */
      minEntries: z.number().min(0).default(1000),
      /** Number of entries to retain after snapshot for debugging. Default: 100. */
      tailSize: z.number().min(0).default(100),
    })
    .default({}),
})

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>

/**
 * Auth Specific Configuration
 */
export const AuthConfigSchema = z.object({
  keysDb: z.string().default('keys.db'),
  tokensDb: z.string().default('tokens.db'),
  revocation: z
    .object({
      enabled: z.boolean().default(false),
      maxSize: z.number().optional(),
    })
    .default({ enabled: false }),
  // NOTE: remove the bootstrap token and ttl, the boostrap token should live only for 1hours (short lived token)
  // fix the ramiufications of this
  bootstrap: z
    .object({
      token: z.string().optional(),
      ttl: z
        .number()
        .default(24 * 60 * 60 * 1000)
        .optional(), // 24 hours
    })
    .default({}),
})

export type AuthConfig = z.infer<typeof AuthConfigSchema>

/**
 * Dashboard configuration — operator-configurable observability links.
 * URL templates may use `{service}` as a placeholder for the OTEL service name.
 */
export const DashboardConfigSchema = z.object({
  links: z.record(z.string(), z.string()).optional(),
})

export type DashboardConfig = z.infer<typeof DashboardConfigSchema>

/**
 * Load dashboard links from file or env var.
 *
 * Precedence:
 * 1. CATALYST_DASHBOARD_LINKS_FILE → read file, throw on missing/invalid
 * 2. CATALYST_DASHBOARD_LINKS → parse inline JSON, throw on invalid
 * 3. Neither set → undefined
 */
export function loadDashboardLinks(): DashboardConfig['links'] | undefined {
  const filePath = process.env.CATALYST_DASHBOARD_LINKS_FILE
  if (filePath) {
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf-8')
    } catch (err) {
      throw new Error(
        `CATALYST_DASHBOARD_LINKS_FILE: cannot read ${filePath}: ${(err as Error).message}`
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`CATALYST_DASHBOARD_LINKS_FILE: invalid JSON in ${filePath}`)
    }
    return DashboardConfigSchema.shape.links.parse(parsed)
  }

  const envVar = process.env.CATALYST_DASHBOARD_LINKS
  if (envVar) {
    let parsed: unknown
    try {
      parsed = JSON.parse(envVar)
    } catch {
      throw new Error('CATALYST_DASHBOARD_LINKS: invalid JSON')
    }
    return DashboardConfigSchema.shape.links.parse(parsed)
  }

  return undefined
}

/**
 * Top-level Catalyst System Configuration
 */
export const CatalystConfigSchema = z.object({
  node: NodeConfigSchema,
  orchestrator: OrchestratorConfigSchema.optional(),
  auth: AuthConfigSchema.optional(),
  envoy: EnvoyConfigSchema.optional(),
  dashboard: DashboardConfigSchema.optional(),
  port: z.number().default(3000),
})

export type CatalystConfig = z.infer<typeof CatalystConfigSchema>

type ServiceType = 'gateway' | 'orchestrator' | 'auth' | 'envoy'

/**
 * Configuration load options
 *
 * Able to handle a
 */
type ConfigLoadOptions = {
  serviceType?: ServiceType | null
}

/**
 * Loads the default configuration from environment variables.
 *
 * @param options - The options for the configuration load.
 */
export function loadDefaultConfig(options: ConfigLoadOptions = {}): CatalystConfig {
  const nodeName = process.env.CATALYST_NODE_ID
  if (!nodeName) {
    throw new Error('CATALYST_NODE_ID environment variable is required')
  }

  // MUST EXIST for the ORCHESTRATOR
  const peeringEndpoint = process.env.CATALYST_PEERING_ENDPOINT
  if (
    !peeringEndpoint &&
    (!options || options.serviceType === null || options.serviceType === 'orchestrator')
  ) {
    throw new Error(
      'CATALYST_PEERING_ENDPOINT environment variable is required for the orchestrator'
    )
  }

  //Oonly required for the ORCH and AUTH
  const domains = process.env.CATALYST_DOMAINS
    ? process.env.CATALYST_DOMAINS.split(',').map((d) => d.trim())
    : []

  const hasEnvoyEnv =
    process.env.CATALYST_ENVOY_ADMIN_PORT ||
    process.env.CATALYST_ENVOY_XDS_PORT ||
    process.env.CATALYST_ENVOY_BIND_ADDRESS
  const envoy = hasEnvoyEnv
    ? {
        adminPort: process.env.CATALYST_ENVOY_ADMIN_PORT
          ? Number(process.env.CATALYST_ENVOY_ADMIN_PORT)
          : undefined,
        xdsPort: process.env.CATALYST_ENVOY_XDS_PORT
          ? Number(process.env.CATALYST_ENVOY_XDS_PORT)
          : undefined,
        bindAddress: process.env.CATALYST_ENVOY_BIND_ADDRESS || undefined,
      }
    : undefined

  const envoyPortRange = process.env.CATALYST_ENVOY_PORT_RANGE
  const envoyEndpoint = process.env.CATALYST_ENVOY_ENDPOINT
  const envoyConfig =
    envoyPortRange && envoyEndpoint
      ? {
          endpoint: envoyEndpoint,
          envoyAddress: process.env.CATALYST_ENVOY_ADDRESS || undefined,
          portRange: JSON.parse(envoyPortRange) as unknown,
        }
      : undefined

  const links = loadDashboardLinks()
  const dashboard = links ? { links } : undefined

  // Only include orchestrator config when envoyConfig is available (i.e. the env vars are set)
  const orchestrator = envoyConfig
    ? {
        gqlGatewayConfig: process.env.CATALYST_GQL_GATEWAY_ENDPOINT
          ? { endpoint: process.env.CATALYST_GQL_GATEWAY_ENDPOINT }
          : undefined,
        auth:
          process.env.CATALYST_AUTH_ENDPOINT && process.env.CATALYST_SYSTEM_TOKEN
            ? {
                endpoint: process.env.CATALYST_AUTH_ENDPOINT,
                systemToken: process.env.CATALYST_SYSTEM_TOKEN,
              }
            : undefined,
        envoyConfig,
        journal: {
          mode: process.env.CATALYST_JOURNAL_MODE || undefined,
          path: process.env.CATALYST_JOURNAL_PATH || undefined,
          compactionIntervalMs: process.env.CATALYST_JOURNAL_COMPACTION_INTERVAL_MS
            ? Number(process.env.CATALYST_JOURNAL_COMPACTION_INTERVAL_MS)
            : undefined,
          minEntries: process.env.CATALYST_JOURNAL_MIN_ENTRIES
            ? Number(process.env.CATALYST_JOURNAL_MIN_ENTRIES)
            : undefined,
          tailSize: process.env.CATALYST_JOURNAL_TAIL_SIZE
            ? Number(process.env.CATALYST_JOURNAL_TAIL_SIZE)
            : undefined,
        },
      }
    : undefined

  return CatalystConfigSchema.parse({
    port: Number(process.env.PORT) || 3000,
    dashboard,
    node: {
      name: nodeName,
      endpoint: peeringEndpoint,
      domains: domains,
      envoyAddress: process.env.CATALYST_ENVOY_ADDRESS || undefined,
    },
    envoy,
    orchestrator,
    auth: {
      keysDb: process.env.CATALYST_AUTH_KEYS_DB,
      tokensDb: process.env.CATALYST_AUTH_TOKENS_DB,
      revocation: {
        enabled: process.env.CATALYST_AUTH_REVOCATION === 'true',
        maxSize: process.env.CATALYST_AUTH_REVOCATION_MAX_SIZE
          ? Number(process.env.CATALYST_AUTH_REVOCATION_MAX_SIZE)
          : undefined,
      },
      bootstrap: {
        token: process.env.CATALYST_BOOTSTRAP_TOKEN,
        ttl: process.env.CATALYST_BOOTSTRAP_TTL
          ? Number(process.env.CATALYST_BOOTSTRAP_TTL)
          : undefined,
      },
    },
  })
}
