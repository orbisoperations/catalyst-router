// Types and interfaces
export type {
  IKeyManager,
  KeyManagerConfig,
  KeyState,
  RotateOptions,
  RotationResult,
  SignOptions,
  VerifyOptions,
  VerifyResult,
} from './types.js'

// Base class and types
export { BaseKeyManager, type ManagedKey } from './base.js'

// Implementations
export { EphemeralKeyManager } from './ephemeral.js'
export { FileSystemKeyManager } from './local.js'

// Factory
export { createKeyManager, createKeyManagerFromEnv } from './factory.js'
