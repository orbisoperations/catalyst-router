// ── New emulator system exports ──────────────────────────────────────────────

export { createSimulator } from './simulation-engine'
export { getEmulator, initEmulatorRegistry, listEmulators, registerEmulator } from './registry'
export { CoTFactory } from './cot-factory'
export type { CoTSimulator, EmulatorRegionConfig } from './types'

// ── Deprecated legacy exports (backward compat) ─────────────────────────────

/** @deprecated Use EMULATOR_PUBLISHERS with emulator="wiesbaden" instead. */
export { initializeWiesbadenSim } from './wiesbaden-sim'

/**
 * @deprecated Use EMULATOR_PUBLISHERS with emulator="virginia" (or a DC-area emulator) instead.
 *
 * Legacy identity emulator: spawns 20 random CoT targets around Washington DC.
 * Kept for backward compatibility with PUBLISH_ZENO_TOPIC_EMULATOR.
 */
export { initializeIdentity } from './legacy-identity'
