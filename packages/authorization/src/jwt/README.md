# JWT Token Manager

The JWT module provides high-level token management, abstraction over raw cryptographic signing, and integration with the Catalyst Policy Engine.

## Features

- **Structured Minting**: Enforces strict typing for entities, roles, and claims during token creation.
- **Certificate Binding**: Supports RFC 8705 Certificate-Bound Access Tokens via the `cnf` claim (ADR 0007).
- **Revocation**: Built-in support for revoking tokens by ID (JTI) or Subject Alternative Name (SAN).
- **Policy Integration**: Helper utilities to map JWT payloads directly to Cedar entities.

## Architecture

The `TokenManager` sits on top of the `KeyManager`:

1.  **Minting**: Validates input -> Constructs Claims -> Signs with `KeyManager` -> Persists Metadata.
2.  **Verification**: Verifies Signature (`KeyManager`) -> Checks Revocation Store -> Returns Payload.

## Usage

### Initialization

```typescript
import { LocalTokenManager } from '@catalyst-node/authorization/jwt'
import { BunSqliteTokenStore } from '@catalyst-node/authorization/jwt/local/sqlite-store'

const tokenStore = new BunSqliteTokenStore('./tokens.db')
const tokenManager = new LocalTokenManager(keyManager, tokenStore, 'node-01')
```

### Minting a Token

```typescript
import { EntityTypeEnum, RoleEnum } from '@catalyst-node/authorization/jwt'

const token = await tokenManager.mint({
  subject: 'alice',
  roles: [RoleEnum.enum.USER],
  entity: {
    id: 'alice',
    name: 'alice',
    type: EntityTypeEnum.enum.user,
    role: RoleEnum.enum.USER,
  },
  // Optional: Bind to a certificate fingerprint (mTLS)
  certificateFingerprint: 'sha256:...',
})
```

### Verifying a Token

```typescript
const result = await tokenManager.verify(token)

if (!result.valid) {
  console.error('Invalid token:', result.error)
} else {
  console.log('Valid token for:', result.payload.sub)
}
```

### Revocation

```typescript
// Revoke a specific token
await tokenManager.revoke({ jti: 'uuid-of-token' })

// Revoke all tokens for a specific SAN (e.g., a compromised DNS name)
await tokenManager.revoke({ san: 'compromised-service.internal' })
```
