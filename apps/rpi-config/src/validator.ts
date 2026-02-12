import { findLayer } from './layers.js'
import type { RpiImageGenConfig } from './types.js'

const BUILTIN_LAYERS = new Set([
  'rpi5',
  'pi4',
  'cm5',
  'cm4',
  'zero2w',
  'image-rpios',
  'docker-debian-bookworm',
])

const BUILTIN_CONFIGS = new Set(['bookworm-minbase.yaml'])

export interface ValidationResult {
  name: string
  kind: 'config' | 'layer'
  found: boolean
  location: 'embedded' | 'built-in' | 'not-found'
}

export function validateLayers(config: RpiImageGenConfig): ValidationResult[] {
  const results: ValidationResult[] = []

  // 1. Validate include config file
  const includeFile = config.include.file
  results.push({
    name: includeFile,
    kind: 'config',
    found: BUILTIN_CONFIGS.has(includeFile),
    location: BUILTIN_CONFIGS.has(includeFile) ? 'built-in' : 'not-found',
  })

  // 2. Validate all layer references
  const layerNames = new Set<string>()
  if (config.device.layer) layerNames.add(config.device.layer)
  if (config.image.layer) layerNames.add(config.image.layer)
  for (const val of Object.values(config.layer)) {
    layerNames.add(val)
  }

  for (const name of layerNames) {
    const embedded = findLayer(name)
    const isBuiltin = BUILTIN_LAYERS.has(name)
    const found = embedded !== undefined || isBuiltin

    let location: ValidationResult['location'] = 'not-found'
    if (embedded !== undefined) {
      location = 'embedded'
    } else if (isBuiltin) {
      location = 'built-in'
    }

    results.push({ name, kind: 'layer', found, location })
  }

  return results
}

export function printValidationResults(results: ValidationResult[]): void {
  const stderr = process.stderr
  stderr.write('\nValidating layers...\n')

  const maxName = Math.max(...results.map((r) => r.name.length))

  for (const r of results) {
    const icon = r.found ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m'
    const name = r.name.padEnd(maxName + 2)
    const loc = r.found ? `${r.kind} (${r.location})` : 'NOT FOUND'
    stderr.write(`  ${icon} ${name} ${loc}\n`)
  }
}
