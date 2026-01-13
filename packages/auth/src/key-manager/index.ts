// Types and interfaces
export type {
    IKeyManager,
    SignOptions,
    VerifyOptions,
    VerifyResult,
    RotateOptions,
    RotationResult,
    KeyState,
    KeyManagerConfig,
} from './types.js';

// Base class and types
export { BaseKeyManager, type ManagedKey } from './base.js';

// Implementations
export { FileSystemKeyManager } from './local.js';
export { EphemeralKeyManager } from './ephemeral.js';

// Factory
export { createKeyManager, createKeyManagerFromEnv } from './factory.js';
