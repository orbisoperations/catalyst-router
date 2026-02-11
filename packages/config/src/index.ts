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
  portRange: z.array(PortEntrySchema).min(1),
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
    })
    .optional(),
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
 * Top-level Catalyst System Configuration
 */
export const CatalystConfigSchema = z.object({
  node: NodeConfigSchema,
  orchestrator: OrchestratorConfigSchema.optional(),
  auth: AuthConfigSchema.optional(),
  envoy: EnvoyConfigSchema.optional(),
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

  const envoyPortRange = process.env.CATALYST_ENVOY_PORT_RANGE
  const envoy = envoyPortRange
    ? {
        portRange: JSON.parse(envoyPortRange) as unknown,
        adminPort: process.env.CATALYST_ENVOY_ADMIN_PORT
          ? Number(process.env.CATALYST_ENVOY_ADMIN_PORT)
          : undefined,
        xdsPort: process.env.CATALYST_ENVOY_XDS_PORT
          ? Number(process.env.CATALYST_ENVOY_XDS_PORT)
          : undefined,
        bindAddress: process.env.CATALYST_ENVOY_BIND_ADDRESS || undefined,
      }
    : undefined

  return CatalystConfigSchema.parse({
    port: Number(process.env.PORT) || 3000,
    node: {
      name: nodeName,
      endpoint: peeringEndpoint,
      domains: domains,
    },
    envoy,
    orchestrator: {
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
    },
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
