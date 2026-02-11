# Key Manager

The Key Manager module handles the lifecycle of cryptographic keys used for signing and verifying tokens. It provides a robust mechanism for key rotation, persistence, and secure usage.

## Core Concepts

### `IKeyManager`

The primary interface `IKeyManager` defines the contract for any key management implementation:

- **Sign**: Create a signature for a payload.
- **Verify**: Verify a token's signature.
- **Get JWKS**: Retrieve public keys in JSON Web Key Set format.
- **Rotate**: Generate a new signing key, optionally keeping the old one active for a grace period.

### `PersistentLocalKeyManager`

The default implementation `PersistentLocalKeyManager` stores keys locally using a provided `IKeyStore` (e.g., SQLite, File System). It is designed to be:

- **Stateful**: Remembers previous keys to support validating tokens issued before rotation.
- **Resilient**: Loads keys from storage on initialization.
- **Secure**: Handles private key operations internally.

## Key Rotation

Key rotation is a critical security feature. When `rotate()` is called:

1. A new key pair (ES384) is generated.
2. The current key is moved to a "previous keys" list.
3. **Grace Period**: The old key remains valid for verification until the grace period expires (default: 24 hours). This ensures in-flight requests or recently issued tokens don't immediately fail.
4. The new state is persisted via the `IKeyStore`.

## Usage

```typescript
import { PersistentLocalKeyManager } from '@catalyst-router/authorization/key-manager'
import { BunSqliteKeyStore } from '@catalyst-router/authorization/key-manager/sqlite-key-store'

// 1. Initialize Store
const store = new BunSqliteKeyStore('./keys.db')

// 2. Initialize Manager
const keyManager = new PersistentLocalKeyManager(store, {
  gracePeriodMs: 1000 * 60 * 60 * 24, // 24 hours
})
await keyManager.initialize()

// 3. Sign Data
const signature = await keyManager.sign({
  subject: 'user-123',
  claims: { role: 'admin' },
})

// 4. Verify Data
const result = await keyManager.verify(token)
if (result.valid) {
  console.log('Payload:', result.payload)
}

// 5. Rotate Keys
const rotationResult = await keyManager.rotate()
console.log(`Rotated from ${rotationResult.previousKeyId} to ${rotationResult.newKeyId}`)
```
