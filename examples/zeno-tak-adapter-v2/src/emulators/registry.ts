import type { EmulatorRegionConfig } from './types'

// ── Registry ─────────────────────────────────────────────────────────────────

const registry = new Map<string, EmulatorRegionConfig>()

/** Register a region config in the emulator registry. */
export function registerEmulator(config: EmulatorRegionConfig): void {
  if (registry.has(config.name)) {
    console.warn(`[emulator-registry] overwriting existing emulator '${config.name}'`)
  }
  registry.set(config.name, config)
}

/** Look up a registered emulator by name. */
export function getEmulator(name: string): EmulatorRegionConfig | undefined {
  return registry.get(name)
}

/** List all registered emulator names. */
export function listEmulators(): string[] {
  return [...registry.keys()]
}

// ── Initialization ───────────────────────────────────────────────────────────

/** Load all built-in region configs into the registry. */
export async function initEmulatorRegistry(): Promise<void> {
  // Dynamic imports keep the registry decoupled from region files
  const { wiesbadenConfig } = await import('./regions/wiesbaden')
  const { japanConfig } = await import('./regions/japan')
  const { virginiaConfig } = await import('./regions/virginia')
  const { chinaConfig } = await import('./regions/china')
  const { russiaConfig } = await import('./regions/russia')

  const configs = [wiesbadenConfig, japanConfig, virginiaConfig, chinaConfig, russiaConfig]
  for (const config of configs) {
    registerEmulator(config)
  }

  console.log(
    `[emulator-registry] loaded ${registry.size} emulators: ${listEmulators().join(', ')}`
  )
}
