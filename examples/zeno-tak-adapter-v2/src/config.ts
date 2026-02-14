import crypto from 'crypto'
import { z } from 'zod'

// --- Schemas ---

const booleanFromString = z.union([z.boolean(), z.string()]).transform((val) => {
  if (typeof val === 'boolean') return val
  if (typeof val === 'string') return val === 'true' || val === '1'
  return undefined
})

const ZenohConfigSchema = z.object({
  routerUrl: z.string().min(1),
  user: z.string().optional(),
  password: z.string().optional(),
  topicPrefix: z.string().optional(),
})

export const SubscriptionSchema = z.object({
  topic: z.string(),
  transform: z.string().default('identity'),
  overrides: z.record(z.string(), z.any()).optional(),
})

const TakConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number(),
  tls: z
    .object({
      cert: z.string().optional(),
      key: z.string().optional(),
      ca: z.string().optional(),
      passphrase: z.string().optional(),
      rejectUnauthorized: booleanFromString.default(false),
    })
    .optional(),
  heartbeat: z.object({
    enabled: booleanFromString.default(false),
    callsign: z.string().default('zeno-adapter'),
    callsignUid: z.string().default(`zeno-tak-adapter-${crypto.randomUUID()}`),
    groupRole: z.string().default('Team Member'),
    groupName: z.string().default('Dark Blue'),
    intervalMs: z.coerce.number().default(10000),
  }),
  connectionId: z.string().default('zeno-adapter'),
  reconnectInterval: z.coerce.number().default(5000),
})

const ProducerConfigSchema = z.object({
  enabled: booleanFromString.default(false),
  topic: z.string().default('tak/cot'),
  intervalMs: z.coerce.number().default(10000),
})

export const EmulatorPublisherSchema = z.object({
  emulator: z.string(),
  topic: z.string(),
  intervalMs: z.coerce.number().default(1000),
})

const ConfigSchema = z.object({
  zenoh: ZenohConfigSchema,
  tak: TakConfigSchema.optional(),
  subscriptions: z.array(SubscriptionSchema).default([]),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  transformsDir: z.string().optional(),
  producer: ProducerConfigSchema.optional(),
  emulatorPublishers: z.array(EmulatorPublisherSchema).default([]),
})

// --- Types ---

export type Config = z.infer<typeof ConfigSchema>
export type SubscriptionConfig = z.infer<typeof SubscriptionSchema>
export type TakConfig = z.infer<typeof TakConfigSchema>
export type ZenohConfig = z.infer<typeof ZenohConfigSchema>
export type ProducerConfig = z.infer<typeof ProducerConfigSchema>
export type EmulatorPublisherConfig = z.infer<typeof EmulatorPublisherSchema>

// --- Path → env (for user-facing error messages) ---

const CONFIG_PATH_TO_ENV: Record<string, string> = {
  'zenoh.routerUrl': 'ZENOH_ROUTER_URL',
  'zenoh.user': 'ZENOH_USER',
  'zenoh.password': 'ZENOH_PASSWORD',
  'zenoh.topicPrefix': 'ZENOH_TOPIC_PREFIX',
  'tak.host': 'TAK_HOST',
  'tak.port': 'TAK_PORT',
  'tak.tls.cert': 'TAK_TLS_CERT',
  'tak.tls.key': 'TAK_TLS_KEY',
  'tak.tls.ca': 'TAK_TLS_CA',
  'tak.tls.passphrase': 'TAK_TLS_PASSPHRASE',
  'tak.tls.rejectUnauthorized': 'TAK_TLS_REJECT_UNAUTHORIZED',
  'tak.heartbeat.groupRole': 'TAK_HEARTBEAT_GROUP_ROLE',
  'tak.heartbeat.groupName': 'TAK_HEARTBEAT_GROUP_NAME',
  'tak.heartbeat.callsign': 'TAK_HEARTBEAT_CALLSIGN',
  'tak.heartbeat.callsignUid': 'TAK_HEARTBEAT_CALLSIGN_UID',
  'tak.heartbeat.intervalMs': 'TAK_HEARTBEAT_INTERVAL_MS',
  'tak.connectionId': 'TAK_CONNECTION_ID',
  'tak.reconnectInterval': 'TAK_RECONNECT_INTERVAL',
  logLevel: 'LOG_LEVEL',
  transformsDir: 'TRANSFORMS_DIR',
  'producer.enabled': 'PRODUCER_ENABLED',
  'producer.topic': 'PRODUCER_TOPIC',
  'producer.intervalMs': 'PRODUCER_INTERVAL_MS',
}

/** Resolve env var name from Zod path (e.g. "zenoh.routerUrl" → "ZENOH_ROUTER_URL"). */
function pathToEnv(path: string): string {
  if (path in CONFIG_PATH_TO_ENV) return CONFIG_PATH_TO_ENV[path]
  if (path.startsWith('subscriptions')) return 'ZENOH_SUBSCRIPTIONS'
  if (path.startsWith('emulatorPublishers')) return 'EMULATOR_PUBLISHERS'
  return path
}

// --- Parsing ---

/**
 * Parse configuration from environment variables.
 * Throws on validation errors.
 */
export function parseConfig(): Config {
  // Parse subscriptions JSON
  let subscriptions: unknown[] = []
  if (process.env.ZENOH_SUBSCRIPTIONS !== undefined) {
    try {
      subscriptions = JSON.parse(process.env.ZENOH_SUBSCRIPTIONS) as unknown[]
    } catch {
      throw new Error(
        'ZENOH_SUBSCRIPTIONS is not valid JSON. ' +
          'Expected format: \'[{"topic":"demo/test","transform":"simple-cot"}]\''
      )
    }
  }

  // Parse emulator publishers JSON
  let emulatorPublishers: unknown[] = []
  if (process.env.EMULATOR_PUBLISHERS !== undefined) {
    try {
      emulatorPublishers = JSON.parse(process.env.EMULATOR_PUBLISHERS) as unknown[]
    } catch {
      throw new Error(
        'EMULATOR_PUBLISHERS is not valid JSON. ' +
          'Expected format: \'[{"emulator":"wiesbaden","topic":"tak/cot/wiesbaden"}]\''
      )
    }
  }

  // Build producer config only if PRODUCER_ENABLED is set
  let producer: Record<string, unknown> | undefined
  if (process.env.PRODUCER_ENABLED !== undefined) {
    producer = {
      enabled: process.env.PRODUCER_ENABLED,
      topic: process.env.PRODUCER_TOPIC,
      intervalMs: process.env.PRODUCER_INTERVAL_MS,
    }
    // Remove undefined values so Zod defaults work
    producer = JSON.parse(JSON.stringify(producer)) as Record<string, unknown>
  }

  // Build TAK config only if TAK_HOST is set; otherwise leave undefined
  // so the adapter can run in producer-only mode without a TAK connection.
  const tak =
    process.env.TAK_HOST !== undefined
      ? {
          host: process.env.TAK_HOST,
          port: process.env.TAK_PORT,
          tls: {
            cert: process.env.TAK_TLS_CERT,
            key: process.env.TAK_TLS_KEY,
            ca: process.env.TAK_TLS_CA,
            passphrase: process.env.TAK_TLS_PASSPHRASE,
            rejectUnauthorized: process.env.TAK_TLS_REJECT_UNAUTHORIZED,
          },
          heartbeat: {
            enabled: process.env.TAK_HEARTBEAT_ENABLED,
            callsign: process.env.TAK_HEARTBEAT_CALLSIGN,
            callsignUid: process.env.TAK_HEARTBEAT_CALLSIGN_UID,
            groupRole: process.env.TAK_HEARTBEAT_GROUP_ROLE,
            groupName: process.env.TAK_HEARTBEAT_GROUP_NAME,
            intervalMs: process.env.TAK_HEARTBEAT_INTERVAL_MS,
          },
          connectionId: process.env.TAK_CONNECTION_ID,
          reconnectInterval: process.env.TAK_RECONNECT_INTERVAL,
        }
      : undefined

  const rawConfig = {
    zenoh: {
      routerUrl: process.env.ZENOH_ROUTER_URL,
      user: process.env.ZENOH_USER,
      password: process.env.ZENOH_PASSWORD,
      topicPrefix: process.env.ZENOH_TOPIC_PREFIX,
    },
    tak,
    subscriptions,
    logLevel: process.env.LOG_LEVEL,
    transformsDir: process.env.TRANSFORMS_DIR,
    producer,
    emulatorPublishers,
  }

  // Remove undefined values to let Zod defaults work
  const cleanConfig = rawConfig

  const parsed = ConfigSchema.safeParse(cleanConfig)

  if (!parsed.success) {
    const requiredEnv = new Set<string>()
    const lines = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.')
      const envName = pathToEnv(path)
      if (['zenoh.routerUrl'].includes(path)) {
        requiredEnv.add(envName)
      }
      return `  - Set ${envName}: ${issue.message} (config path: ${path})`
    })
    const requiredHint =
      requiredEnv.size > 0 ? `\nRequired env: ${[...requiredEnv].sort().join(', ')}.` : ''
    throw new Error(`Configuration error:${requiredHint}\n${lines.join('\n')}`)
  }

  return parsed.data
}
