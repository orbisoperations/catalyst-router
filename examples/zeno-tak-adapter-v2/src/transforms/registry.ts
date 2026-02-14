import * as fs from 'fs'
import * as path from 'path'
import { builtinTransforms } from './builtin'
import type { TransformPlugin } from './types'

/**
 * Registry of loaded transform plugins.
 */
const registry = new Map<string, TransformPlugin>()

/**
 * Check if a module exports a valid TransformPlugin.
 */
function isValidPlugin(module: unknown): module is { default: TransformPlugin } {
  const plugin = module as { default: TransformPlugin } | undefined
  return (
    !!plugin &&
    typeof plugin === 'object' &&
    typeof plugin.default.name === 'string' &&
    typeof plugin.default.transform === 'function'
  )
}

/**
 * Load a single plugin from a file path.
 */
async function loadPluginFromFile(filePath: string): Promise<TransformPlugin | null> {
  try {
    const module = (await import(filePath)) as { default: TransformPlugin }
    if (!isValidPlugin(module)) {
      console.warn(
        `[transforms] Invalid plugin at ${filePath}: missing 'name' or 'transform' export`
      )
      return null
    }
    return module.default
  } catch (e) {
    console.error(`[transforms] Failed to load plugin from ${filePath}`, e)
    return null
  }
}

/**
 * Scan a directory for transform plugin files.
 */
async function scanDirectory(dirPath: string): Promise<TransformPlugin[]> {
  const plugins: TransformPlugin[] = []

  if (!fs.existsSync(dirPath)) {
    console.debug(`[transforms] Plugin directory not found: ${dirPath}`)
    return plugins
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name)
    if (!['.ts', '.js'].includes(ext)) continue
    if (entry.name.endsWith('.d.ts')) continue

    const filePath = path.resolve(dirPath, entry.name)
    const plugin = await loadPluginFromFile(filePath)
    if (plugin) plugins.push(plugin)
  }

  return plugins
}

/**
 * Register a plugin in the registry.
 */
function registerPlugin(plugin: TransformPlugin): void {
  console.debug(`[transforms] Registering plugin '${plugin.name}'`)
  if (registry.has(plugin.name)) {
    console.warn(`[transforms] Plugin '${plugin.name}' already registered, overwriting`)
  }
  registry.set(plugin.name, plugin)
}

/**
 * Get a plugin by name.
 */
export function getPlugin(name: string): TransformPlugin | undefined {
  console.debug(`[transforms] Getting plugin '${name}'`)
  return registry.get(name)
}

/**
 * Get all registered plugins.
 */
export function getAllPlugins(): TransformPlugin[] {
  return Array.from(registry.values())
}

/**
 * Initialize the transform loader.
 * Loads built-in transforms and optionally scans a user plugin directory.
 */
export async function initTransforms(pluginDir?: string): Promise<void> {
  console.debug(`[transforms] Initializing transforms from '${pluginDir}'`)
  registry.clear()

  for (const plugin of builtinTransforms) {
    registerPlugin(plugin)
  }

  if (pluginDir) {
    const resolvedPath = path.resolve(pluginDir)
    const userPlugins = await scanDirectory(resolvedPath)
    for (const plugin of userPlugins) {
      registerPlugin(plugin)
    }
  }
}

/**
 * Initialize all loaded plugins (calls init hooks).
 */
export async function initAllPlugins(): Promise<void> {
  for (const plugin of registry.values()) {
    if (plugin.init) {
      try {
        await plugin.init()
      } catch (e) {
        console.error(`[transforms] Failed to initialize ${plugin.name}`, e)
      }
    }
  }
}

/**
 * Destroy all loaded plugins (calls destroy hooks).
 */
export async function destroyAllPlugins(): Promise<void> {
  for (const plugin of registry.values()) {
    if (plugin.destroy) {
      try {
        await plugin.destroy()
      } catch (e) {
        console.error(`[transforms] Failed to destroy ${plugin.name}`, e)
      }
    }
  }
}
