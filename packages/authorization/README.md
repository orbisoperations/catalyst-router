# Catalyst Authorization Package

This package provides the core authorization primitives for the Catalyst network. It allows nodes and services to issue, verify, and enforce permissions securely.

## Components

The package is divided into three main sub-systems:

### 1. Key Manager

**Path:** [`src/key-manager`](./src/key-manager)
**Purpose:** Handles the lifecycle of cryptographic keys (ES384).
**Key Features:**

- Automated Key Rotation.
- Secure local persistence.
- Grace periods for old keys to preventing outages during rotation.

[Read more](./src/key-manager/README.md)

### 2. JWT (Token Manager)

**Path:** [`src/jwt`](./src/jwt)
**Purpose:** Manages the issuance and lifecycle of Access Tokens.
**Key Features:**

- Typesafe token minting with Entity and Principal bindings.
- Support for **Certificate-Bound Access Tokens** (mTLS binding).
- Revocation capabilities (Blacklisting).

[Read more](./src/jwt/README.md)

### 3. Policy Engine

**Path:** [`src/policy`](./src/policy)
**Purpose:** Enforces authorization decisions using [Cedar Policy](https://www.cedarpolicy.com/).
**Key Features:**

- Type-safe `EntityBuilder`.
- Catalyst-specific semantic domain (`CATALYST::Action`, `CATALYST::ADMIN`, `CATALYST::NODE`, etc.).
- Composable authorization rules.

[Read more](./src/policy/README.md)

## High-Level Flow

1. **Setup**: A node initializes the `KeyManager` and `TokenStore`.
2. **Issuance**: When an entity authenticates, the `TokenManager` uses the `KeyManager` to sign a new JWT, embedding `Entity` details and a `Principal` (the Cedar entity type, e.g. `CATALYST::ADMIN`).
3. **Authorization**:
   - A request arrives with a JWT.
   - `TokenManager` verifies the signature and checks revocation status.
   - The JWT payload is converted into a Cedar `Entity` via `jwtToEntity` — the `principal` field maps directly to the Cedar entity type.
   - The `AuthorizationEngine` evaluates the `Entity` against the defined Policies to return `ALLOW` or `DENY`.
