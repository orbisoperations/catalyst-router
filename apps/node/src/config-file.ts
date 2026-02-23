import type { Command } from 'commander'
import { z } from 'zod'

/**
 * JSON config file schema for the Catalyst composite node CLI.
 *
 * All fields are optional — config files provide base values that
 * CLI flags and environment variables can override.
 *
 * Keys use camelCase matching CompositeServerOptions field names.
 * Unknown keys are rejected (.strict()) to catch typos early.
 */
export const ConfigFileSchema = z
  .object({
    nodeId: z.string().optional(),
    port: z.union([z.string(), z.number()]).optional(),
    hostname: z.string().optional(),
    peeringEndpoint: z.string().optional(),
    domains: z.array(z.string()).optional(),
    peeringSecret: z.string().optional(),
    keysDb: z.string().optional(),
    tokensDb: z.string().optional(),
    revocation: z.boolean().optional(),
    revocationMaxSize: z.union([z.string(), z.number()]).optional(),
    bootstrapToken: z.string().optional(),
    bootstrapTtl: z.union([z.string(), z.number()]).optional(),
    gatewayEndpoint: z.string().optional(),
    logLevel: z.string().optional(),
  })
  .strict()

export type ConfigFile = z.infer<typeof ConfigFileSchema>

/**
 * Load and validate a JSON config file from the given path.
 *
 * Uses Bun.file() for reading. Returns the validated config object
 * with all values coerced to the string types Commander expects.
 *
 * @throws {Error} if the file does not exist, is not valid JSON,
 *   or fails Zod validation
 */
export async function loadConfigFile(filePath: string): Promise<Record<string, string | boolean>> {
  const file = Bun.file(filePath)
  const exists = await file.exists()
  if (!exists) {
    throw new Error(`Config file not found: ${filePath}`)
  }

  const text = await file.text()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`Config file is not valid JSON: ${filePath}`)
  }

  const parsed = ConfigFileSchema.parse(raw)

  // Coerce all values to the types Commander expects (strings for
  // option-arguments, booleans for boolean flags).
  const result: Record<string, string | boolean> = {}

  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue

    if (key === 'domains' && Array.isArray(value)) {
      result[key] = value.join(',')
    } else if (key === 'revocation' && typeof value === 'boolean') {
      result[key] = value
    } else if (typeof value === 'number') {
      result[key] = String(value)
    } else {
      result[key] = value as string
    }
  }

  return result
}

/**
 * Apply config file values to a Commander command instance.
 *
 * Only sets values where the current source is 'default' — meaning
 * neither CLI flags nor environment variables provided a value.
 * Tags injected values with source 'config' for proper precedence.
 */
export function applyConfigFileValues(
  cmd: Command,
  configValues: Record<string, string | boolean>
): void {
  for (const [key, value] of Object.entries(configValues)) {
    const source = cmd.getOptionValueSource(key)
    if (source === 'default' || source === undefined) {
      cmd.setOptionValueWithSource(key, value, 'config')
    }
  }
}
