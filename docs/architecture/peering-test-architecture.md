# Peering Test Architecture - Cert-Bound Token Flow

## Scenario 1: Shared Auth (1 Auth Server, 2 Orchestrators)

```mermaid
graph TB
    subgraph "Shared Auth Topology"
        Auth[Auth Server<br/>auth.somebiz.local.io]

        subgraph "Node A"
            OrcA[Orchestrator A<br/>node-a.somebiz.local.io]
            TokenA[Node Token A<br/>minted by Auth]
        end

        subgraph "Node B"
            OrcB[Orchestrator B<br/>node-b.somebiz.local.io]
            TokenB[Node Token B<br/>minted by Auth]
        end
    end

    Auth -->|"1. mint node token"| TokenA
    Auth -->|"2. mint node token"| TokenB
    OrcA -->|"3. validate tokens"| Auth
    OrcB -->|"4. validate tokens"| Auth
    OrcA <-.->|"5. peer with valid tokens"| OrcB

    style Auth fill:#e1f5ff
    style OrcA fill:#fff4e1
    style OrcB fill:#fff4e1
```

**Token Flow:**

1. Auth mints `node-token-a` for Orchestrator A
2. Auth mints `node-token-b` for Orchestrator B
3. Both nodes validate tokens via the same Auth server
4. A and B peer using their respective node tokens
5. All tokens signed by same Auth → mutual validation works

**ASCII Diagram:**

```
┌─────────────────────────────────────────────┐
│         Shared Auth Scenario                │
│                                             │
│  ┌──────────┐                               │
│  │  Auth    │ (auth.somebiz.local.io)       │
│  │ Server   │                               │
│  └─────┬────┘                               │
│        │                                    │
│    ┌───┴────┐                               │
│    │        │                               │
│    ▼        ▼                               │
│  ┌──────┐ ┌──────┐                         │
│  │Token │ │Token │                         │
│  │  A   │ │  B   │                         │
│  └───┬──┘ └───┬──┘                         │
│      │        │                             │
│      ▼        ▼                             │
│  ┌────────┐ ┌────────┐                     │
│  │ Orch A │◄─────────►│ Orch B │            │
│  │ node-a │  peering  │ node-b │            │
│  └────────┘           └────────┘            │
│                                             │
│  • Both nodes validate via same Auth       │
│  • Tokens are interchangeable              │
│  • No cross-auth issues                    │
└─────────────────────────────────────────────┘
```

---

## Scenario 2: Separate Auth (2 Auth Servers, 2 Orchestrators)

```mermaid
graph TB
    subgraph "Org A - somebiz.local.io"
        AuthA[Auth Server A<br/>auth-a.somebiz.local.io]
        OrcA[Orchestrator A<br/>node-a.somebiz.local.io]
        NodeTokenA[Node Token A<br/>signed by Auth-A]
        PeerTokenB2A[Peer Token for B→A<br/>signed by Auth-A]
    end

    subgraph "Org B - somebiz.local.io"
        AuthB[Auth Server B<br/>auth-b.somebiz.local.io]
        OrcB[Orchestrator B<br/>node-b.somebiz.local.io]
        NodeTokenB[Node Token B<br/>signed by Auth-B]
        PeerTokenA2B[Peer Token for A→B<br/>signed by Auth-B]
    end

    AuthA -->|"1. mint node token"| NodeTokenA
    AuthA -->|"2. mint peer token for B"| PeerTokenB2A
    AuthB -->|"3. mint node token"| NodeTokenB
    AuthB -->|"4. mint peer token for A"| PeerTokenA2B

    OrcA -->|"validate own tokens"| AuthA
    OrcB -->|"validate own tokens"| AuthB

    OrcB -.->|"5. peer using token from Auth-A"| OrcA
    OrcA -.->|"6. peer using token from Auth-B"| OrcB

    OrcA -->|"7. validate B's token"| AuthA
    OrcB -->|"8. validate A's token"| AuthB

    style AuthA fill:#e1f5ff
    style AuthB fill:#ffe1f5
    style OrcA fill:#fff4e1
    style OrcB fill:#fff4e1
    style PeerTokenB2A fill:#90EE90
    style PeerTokenA2B fill:#90EE90
```

**Cert-Bound Token Flow:**

1. **Auth-A** mints `node-token-a` for Orchestrator A (local ops)
2. **Auth-A** mints `peer-token-b→a` for Orchestrator B to use when peering with A
3. **Auth-B** mints `node-token-b` for Orchestrator B (local ops)
4. **Auth-B** mints `peer-token-a→b` for Orchestrator A to use when peering with B
5. **Orch B** configures peer A with `peer-token-b→a` (signed by Auth-A)
6. **Orch A** configures peer B with `peer-token-a→b` (signed by Auth-B)
7. When B connects to A, A validates the token via Auth-A ✓
8. When A connects to B, B validates the token via Auth-B ✓

**ASCII Diagram:**

```
┌─────────────────────────────────────────────────────────────────┐
│              Separate Auth with Peer Tokens                     │
│                                                                 │
│  ┌─────── Org A ───────┐    ┌─────── Org B ───────┐           │
│  │                      │    │                      │           │
│  │  ┌────────┐          │    │  ┌────────┐          │           │
│  │  │Auth-A  │          │    │  │Auth-B  │          │           │
│  │  └───┬────┘          │    │  └───┬────┘          │           │
│  │      │               │    │      │               │           │
│  │  ┌───┴────┬─────┐   │    │  ┌───┴────┬─────┐   │           │
│  │  │        │     │   │    │  │        │     │   │           │
│  │  ▼        ▼     │   │    │  ▼        ▼     │   │           │
│  │┌──────┐┌──────┐ │   │    │┌──────┐┌──────┐ │   │           │
│  ││Token ││Peer  │◄┼───┼────┼│      ││Token │ │   │           │
│  ││  A   ││Token │ │   │    │└──────┘│  B   │ │   │           │
│  ││(own) ││(B→A) │ │   │    │        │(own) │ │   │           │
│  │└───┬──┘└───┬──┘ │   │    │        └───┬──┘ │   │           │
│  │    │       └────┼───┼────┼►┐          │    │   │           │
│  │    ▼            │   │    │ │          ▼    │   │           │
│  │ ┌──────┐        │   │    │ │      ┌──────┐ │   │           │
│  │ │Orch A│◄───────┼───┼────┼─┼──────┤Orch B│ │   │           │
│  │ │node-a│        │   │    │ │      │node-b│ │   │           │
│  │ └──────┘        │   │    │ └──────┴──────┘ │   │           │
│  │      ▲          │   │    │    │             │   │           │
│  │      └──────────┼───┼────┼────┘             │   │           │
│  │                 │   │    │                  │   │           │
│  │  Peer Token A→B │   │    │  Peer Token B→A  │   │           │
│  │  (signed by B)  │   │    │  (signed by A)   │   │           │
│  └─────────────────┘   │    └──────────────────┘   │           │
│                        │                            │           │
│  Flow:                                              │           │
│  1. Auth-A mints Token-A for Orch-A (local)        │           │
│  2. Auth-A mints Peer-Token-B→A for Orch-B         │           │
│  3. Auth-B mints Token-B for Orch-B (local)        │           │
│  4. Auth-B mints Peer-Token-A→B for Orch-A         │           │
│  5. Orch-B uses Peer-Token-B→A to connect to A     │           │
│  6. Orch-A validates token via Auth-A ✓            │           │
│  7. Orch-A uses Peer-Token-A→B to connect to B     │           │
│  8. Orch-B validates token via Auth-B ✓            │           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Differences

| Aspect           | Shared Auth                  | Separate Auth                                        |
| ---------------- | ---------------------------- | ---------------------------------------------------- |
| Auth Servers     | 1                            | 2                                                    |
| Token Validation | Single source                | Each org validates its own                           |
| Peer Tokens      | Node tokens work for peering | Explicit peer tokens required                        |
| Trust Model      | Centralized                  | Federated                                            |
| Token Minting    | Auth mints all tokens        | Each auth mints for its org + peer tokens for others |

---

## Implementation Requirements

### 1. Peer Configuration Updates

```typescript
interface PeerInfo {
  name: string
  endpoint: string
  domains: string[]
  peerToken?: string // Token to use when connecting to this peer
}
```

### 2. Remove SKIP_AUTH

- Delete all `CATALYST_SKIP_AUTH` checks
- Force proper token validation

### 3. Token Validation Flow

```typescript
// When peer B connects to A:
// 1. B sends peerToken (minted by Auth-A)
// 2. A validates token via Auth-A
// 3. Token is cert-bound (future: includes cert fingerprint)
```

### 4. Test Updates

- **Shared Auth:** Use node tokens for peering (already works)
- **Separate Auth:** Mint peer tokens and provide in peer config
- **Security:** Verify tokens from wrong auth are rejected
