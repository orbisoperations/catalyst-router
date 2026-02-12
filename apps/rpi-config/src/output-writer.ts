import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findLayer } from './layers.js'
import type { RpiImageGenConfig } from './types.js'

export interface WriteOutputOptions {
  outputDir: string
  configYaml: string
  config: RpiImageGenConfig
  mode: 'native' | 'docker'
}

/** Layer names provided by rpi-image-gen itself (not embedded). */
const BUILTIN_LAYERS = new Set([
  'rpi5',
  'pi4',
  'cm5',
  'cm4',
  'zero2w',
  'image-rpios',
  'docker-debian-bookworm',
])

export function writeOutputDir(opts: WriteOutputOptions): void {
  const { outputDir, configYaml, config, mode } = opts
  const layerDir = join(outputDir, 'layer')
  const binDir = join(outputDir, 'bin')

  // Create directory structure
  mkdirSync(layerDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })

  // Write config.yaml
  writeFileSync(join(outputDir, 'config.yaml'), configYaml, 'utf-8')

  // Write only the layers referenced by config.layer that we have embedded
  const writtenLayers = new Set<string>()
  for (const layerName of Object.values(config.layer)) {
    if (BUILTIN_LAYERS.has(layerName)) continue
    if (writtenLayers.has(layerName)) continue

    const embedded = findLayer(layerName)
    if (embedded) {
      writeFileSync(join(layerDir, embedded.filename), embedded.content, 'utf-8')
      writtenLayers.add(layerName)
    }
  }

  // In native mode, warn if the catalyst-node binary is missing
  if (mode === 'native') {
    const binaryPath = join(binDir, 'catalyst-node')
    if (!existsSync(binaryPath)) {
      process.stderr.write(
        `warning: ${binaryPath} not found. Copy the catalyst-node binary here before building.\n`
      )
    }
  }
}
