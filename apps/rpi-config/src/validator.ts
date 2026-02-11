import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RpiImageGenConfig } from './types.js'

export interface ValidationResult {
  name: string
  kind: 'config' | 'layer'
  found: boolean
  location: 'built-in' | 'source-dir' | 'not-found'
  path?: string
}

export function validateLayers(
  config: RpiImageGenConfig,
  rpiImageGenPath: string,
  sourceDir: string
): ValidationResult[] {
  const igRoot = resolve(rpiImageGenPath)
  const srcRoot = resolve(sourceDir)
  const results: ValidationResult[] = []

  // 1. Validate include config file
  const includeFile = config.include.file
  const configSearchPaths = [join(srcRoot, 'config'), join(igRoot, 'config')]
  const includePath = findFile(includeFile, configSearchPaths)
  results.push({
    name: includeFile,
    kind: 'config',
    found: includePath !== undefined,
    location: classifyLocation(includePath, igRoot, srcRoot),
    path: includePath,
  })

  // 2. Validate all layer references
  const layerSearchPaths = [
    join(srcRoot, 'layer'),
    join(srcRoot, 'device'),
    join(srcRoot, 'image'),
    join(igRoot, 'layer'),
    join(igRoot, 'device'),
    join(igRoot, 'image'),
  ]

  // Collect layer names from device.layer, image.layer, and layer.*
  const layerNames = new Set<string>()
  if (config.device.layer) layerNames.add(config.device.layer)
  if (config.image.layer) layerNames.add(config.image.layer)
  for (const val of Object.values(config.layer)) {
    layerNames.add(val)
  }

  for (const name of layerNames) {
    const found = findLayerYaml(name, layerSearchPaths)
    results.push({
      name,
      kind: 'layer',
      found: found !== undefined,
      location: classifyLocation(found, igRoot, srcRoot),
      path: found,
    })
  }

  return results
}

function classifyLocation(
  path: string | undefined,
  igRoot: string,
  srcRoot: string
): 'built-in' | 'source-dir' | 'not-found' {
  if (!path) return 'not-found'
  if (path.startsWith(igRoot)) return 'built-in'
  if (path.startsWith(srcRoot)) return 'source-dir'
  return 'not-found'
}

function findFile(filename: string, dirs: string[]): string | undefined {
  for (const dir of dirs) {
    const candidate = join(dir, filename)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function findLayerYaml(layerName: string, searchDirs: string[]): string | undefined {
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue
    // Direct: dir/<name>.yaml
    const direct = join(dir, `${layerName}.yaml`)
    if (existsSync(direct)) return direct
    // Nested: dir/**/<name>.yaml (up to 3 levels)
    const found = findRecursive(dir, `${layerName}.yaml`, 3)
    if (found) return found
  }
  return undefined
}

function findRecursive(dir: string, filename: string, maxDepth: number): string | undefined {
  if (maxDepth <= 0) return undefined
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === filename) {
        return join(dir, entry.name)
      }
      if (entry.isDirectory()) {
        const found = findRecursive(join(dir, entry.name), filename, maxDepth - 1)
        if (found) return found
      }
    }
  } catch {
    // Permission denied, etc.
  }
  return undefined
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
