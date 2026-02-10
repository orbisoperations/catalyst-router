# Catalyst Auth Service

The Auth service provides centralized authentication and authorization for the Catalyst node. It manages cryptographic keys, JWT issuance/verification, and role-based access control (RBAC).

## Roles & Permissions

Catalyst uses an explicit, role-based permission system. Permissions are categorized by functional area (Tokens, Peers, Routes, Protocol).

| Role               | Description                   | Cedar Principal            | Permissions                                      |
| :----------------- | :---------------------------- | :------------------------- | :----------------------------------------------- |
| **ADMIN**          | Full system access            | `CATALYST::ADMIN`          | `*` (All permissions)                            |
| **NODE**           | Internal protocol participant | `CATALYST::NODE`           | `ibgp:connect`, `ibgp:disconnect`, `ibgp:update` |
| **NODE_CUSTODIAN** | Manage node peer topology     | `CATALYST::NODE_CUSTODIAN` | `peer:create`, `peer:update`, `peer:delete`      |
| **DATA_CUSTODIAN** | Manage routing and services   | `CATALYST::DATA_CUSTODIAN` | `route:create`, `route:delete`                   |
| **USER**           | Basic access                  | `CATALYST::USER`           | No management permissions                        |

### Permission Dictionary

| Category  | Permission        | Description                         |
| :-------- | :---------------- | :---------------------------------- |
| **Token** | `token:create`    | Issue new JWTs                      |
|           | `token:revoke`    | Revoke existing tokens              |
|           | `token:list`      | List active service accounts/tokens |
| **Peer**  | `peer:create`     | Add new neighbor nodes              |
|           | `peer:update`     | Update neighbor configuration       |
|           | `peer:delete`     | Remove neighbor nodes               |
| **Route** | `route:create`    | Advertise new local services/routes |
|           | `route:delete`    | Withdraw local routes               |
| **IBGP**  | `ibgp:connect`    | Establish internal protocol session |
|           | `ibgp:disconnect` | Tear down internal protocol session |
|           | `ibgp:update`     | Exchange routing updates            |

---

## Administrative System Token

When the Auth service starts, it automatically mints a high-privilege **System Admin Token**. This token is intended for use by the node orchestrator and automated system tasks.

### Token Minting Logic

The token is generated immediately after the `KeyManager` initializes. It contains:

- `sub`: `"bootstrap"`
- `roles`: `["ADMIN"]`
- `entity.role`: `"ADMIN"` (maps to Cedar principal `CATALYST::ADMIN`)

### Accessing the Token

#### 1. Via Console Logs (Container/Production)

The token is logged to `stdout` in JSON format on startup:

```json
{ "level": "info", "msg": "System Admin Token minted", "token": "eyJhbGciOiJFUzM4NC..." }
```

#### 2. Programmatically (Tests/Library)

If you are running the Auth service as a library (e.g., in unit/integration tests), you can access the token after creating the service:

```typescript
import { loadDefaultConfig } from '@catalyst/config'
import { AuthService } from '@catalyst/auth-service'

const config = loadDefaultConfig()
const auth = await AuthService.create({ config })
console.log('Admin Token:', auth.systemToken)
```

The `startServer()` convenience function also returns the token:

```typescript
import { startServer } from '@catalyst/auth-service'

const { systemToken } = await startServer()
```
