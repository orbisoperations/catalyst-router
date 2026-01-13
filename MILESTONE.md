# Trust Fabric Architecture Documentation

## Table of Contents

- [Trust Fabric Architecture Documentation](#trust-fabric-architecture-documentation)
  - [Table of Contents](#table-of-contents)
  - [Stage 1: Pure Application-Layer](#stage-1-pure-application-layer)
    - [Single Gateway](#single-gateway)
    - [Two Gateways - Internal Trust (Milestone 1 (M1))](#two-gateways---internal-trust-milestone-1-m1)
    - [Two Gateways - External Trust (Milestone 2 (M2))](#two-gateways---external-trust-milestone-2-m2)
    - [Offline Policy Enforcement](#offline-policy-enforcement)
  - [Cross-Deployment Query Flow](#cross-deployment-query-flow)

---

## Stage 1: Pure Application-Layer

### Single Gateway 

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    STAGE 1A: SINGLE GATEWAY (Milestone 0 (M0))               │
│                                                                              │
│                               ┌─────────────────┐                            │
│                               │     CLIENT      │                            │
│                               └────────┬────────┘                            │
│                                        │                                     │
│                                        │ HTTPS + JWT                         │
│                                        ▼                                     │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                            GATEWAY NODE                                │  │
│  │                                                                        │  │
│  │  ┌─────────────┐    ┌─────────────┐    ┌───────────────────────────┐   │  │
│  │  │ Hypertext   │    │  GraphQL    │    │       Auth Layer          │   │  │
│  │  │ Transfer    │───►│   Yoga      │───►│  ┌───────────────────┐    │   │  │
│  │  │ Protocol    │    │             │    │  │                   │    │   │  │
│  │  │   Server    │    │  + Stitch   │    │  │  JWKS Loader      │    │   │  │
│  │  └─────────────┘    └──────┬──────┘    │  │  (file-based)     │    │   │  │
│  │                            │           │  └───────────────────┘    │   │  │
│  │                            │           │  ┌───────────────────┐    │   │  │
│  │                            │           │  │  JWT Validator    │    │   │  │
│  │                            │           │  │  (jose)           │    │   │  │
│  │                            │           │  └───────────────────┘    │   │  │
│  │                            │           └───────────────────────────┘   │  │
│  │                            ▼                                           │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐  │  │
│  │  │                      CHANNEL FEDERATION                          │  │  │
│  │  │  ┌──────────┐   ┌──────────┐   ┌──────────┐                      │  │  │
│  │  │  │Channel A │   │Channel B │   │Channel C │                      │  │  │
│  │  │  │ (local)  │   │ (local)  │   │ (local)  │                      │  │  │
│  │  │  └────┬─────┘   └────┬─────┘   └────┬─────┘                      │  │  │
│  │  │       │              │              │                            │  │  │
│  │  └───────┼──────────────┼──────────────┼────────────────────────────┘  │  │
│  │          │              │              │                               │  │
│  └──────────┼──────────────┼──────────────┼───────────────────────────────┘  │
│             │              │              │                                  │
│             ▼              ▼              ▼                                  │
│      ┌──────────┐   ┌──────────┐   ┌──────────┐                              │
│      │ Service  │   │ Service  │   │ Service  │                              │
│      │    A     │   │    B     │   │    C     │                              │
│      └──────────┘   └──────────┘   └──────────┘                              │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  CONFIG (whatever.json)                                                |  │
│  │  {                                                                     │  │
│  │    "gateway": { "id": "gw-1", "port": 4000 },                          │  │
│  │    "jwks": { "source": "file", "path": "./keys/jwks.json" },           │  │
│  │    "channels": [                                                       │  │
│  │      { "id": "svc-a", "endpoint": "http://localhost:5001/graphql" }    │  │
│  │    ]                                                                   │  │
│  │  }                                                                     │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  PROVIDES:                            DOES NOT PROVIDE:                      │
│  ✓ JWT validation                     ✗ Gateway-to-gateway                   │
│  ✓ GraphQL federation                 ✗ Cross-org trust                      │
│  ✓ Schema stitching                   ✗ Encrypted transport (beyond          │
│                                         Transport Layer Security (TLS))      │
│  ✓ Config-based channels              ✗ Network isolation                    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

```mermaid
flowchart TB
    Client[CLIENT]

    subgraph GW["GATEWAY NODE"]
        direction TB
        Hono["Hono HTTP Server"] --> Yoga["GraphQL Yoga + Stitch"]

        subgraph Auth["Auth Layer"]
            JWKS["JWKS Loader<br/>(file-based)"]
            JWT["JWT Validator<br/>(jose)"]
        end

        Yoga --> Auth

        subgraph Channels["CHANNEL FEDERATION"]
            ChA["Channel A<br/>(local)"]
            ChB["Channel B<br/>(local)"]
            ChC["Channel C<br/>(local)"]
        end

        Yoga --> Channels
    end

    SvcA["Service A"]
    SvcB["Service B"]
    SvcC["Service C"]

    Client -->|"HTTPS + JWT"| Hono
    ChA --> SvcA
    ChB --> SvcB
    ChC --> SvcC
```

### Two Gateways - Internal Trust (Milestone 1 (M1))

```
┌──────────────────────────────────────────────────────────────────────────────┐
│               STAGE 1B: TWO GATEWAYS - INTERNAL TRUST (M1)                   │
│                                                                              │
│                               ┌─────────────────┐                            │
│                               │     CLIENT      │                            │
│                               └────────┬────────┘                            │
│                                        │                                     │
│                                        │ HTTPS + JWT                         │
│                                        ▼                                     │
│                                                                              │
│  ┌───────────────────────────────┐        ┌───────────────────────────────┐  │
│  │         GATEWAY A             │        │         GATEWAY B             │  │
│  │         (port 4000)           │        │         (port 4001)           │  │
│  │                               │        │                               │  │
│  │  ┌─────────────────────────┐  │        │  ┌─────────────────────────┐  │  │
│  │  │      GraphQL Yoga       │  │        │  │      GraphQL Yoga       │  │  │
│  │  │      + Stitching        │  │        │  │      + Stitching        │  │  │
│  │  └───────────┬─────────────┘  │        │  └───────────┬─────────────┘  │  │
│  │              │                │        │              │                │  │
│  │  ┌───────────┴─────────────┐  │        │  ┌───────────┴─────────────┐  │  │
│  │  │    Peer Federation      │◄─┼────────┼─►│    Peer Federation      │  │  │
│  │  │  ┌───────────────────┐  │  │ HTTPS  │  │  ┌───────────────────┐  │  │  │
│  │  │  │ Peer: gateway-b   │  │  │ Token  │  │  │ Peer: gateway-a   │  │  │  │
│  │  │  │ endpoint: :4001   │  │  │ Pass-  │  │  │ endpoint: :4000   │  │  │  │
│  │  │  │ trust: internal   │  │  │through │  │  │ trust: internal   │  │  │  │
│  │  │  └───────────────────┘  │  │        │  │  └───────────────────┘  │  │  │
│  │  └─────────────────────────┘  │        │  └─────────────────────────┘  │  ****│
│  │              │                │        │              │                │  │
│  │  ┌───────────┴─────────────┐  │        │  ┌───────────┴─────────────┐  │  │
│  │  │      Auth Layer         │  │        │  │      Auth Layer         │  │  │
│  │  │  ┌───────────────────┐  │  │        │  │  ┌───────────────────┐  │  │  │
│  │  │  │   SHARED JWKS     │  │  │        │  │  │   SHARED JWKS     │  │  │  │
│  │  │  │./shared/jwks.json │  │  │        │  │  │./shared/jwks.json │  │  │  │
│  │  │  └───────────────────┘  │  │        │  │  └───────────────────┘  │  │  │
│  │  └─────────────────────────┘  │        │  └─────────────────────────┘  │  │
│  │              │                │        │              │                │  │
│  │              ▼                │        │              ▼                │  │
│  │  ┌─────────────────────────┐  │        │  ┌─────────────────────────┐  │  │
│  │  │     Local Channels      │  │        │  │     Local Channels      │  │  │
│  │  │  ┌───────┐ ┌───────┐    │  │        │  │  ┌───────┐ ┌───────┐    │  │  │
│  │  │  │ Svc A │ │ Svc B │    │  │        │  │  │ Svc C │ │ Svc D │    │  │  │
│  │  │  └───────┘ └───────┘    │  │        │  │  └───────┘ └───────┘    │  │  │
│  │  └─────────────────────────┘  │        │  └─────────────────────────┘  │  │
│  │                               │        │                               │  │
│  └───────────────────────────────┘        └───────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  TRUST MODEL: SHARED JWKS                                              │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐  │  │
│  │  │                     Same Organization                            │  │  │
│  │  │                                                                  │  │  │
│  │  │   Gateway A ◄────── SHARED JWKS ──────► Gateway B                │  │  │
│  │  │       │              (same keys)              │                  │  │  │
│  │  │       │                                       │                  │  │  │
│  │  │       └──── Token valid at both ──────────────┘                  │  │  │
│  │  │                                                                  │  │  │
│  │  └──────────────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  QUERY FLOW:                                                                 │
│  ────────────────────────────────────────────────────────────────────────-───│
│  1. Client → Gateway A: query { localData, remoteData }                      │
│  2. Gateway A validates JWT against shared JWKS                              │
│  3. Gateway A fetches localData from local services                          │
│  4. Gateway A forwards query to Gateway B (with same JWT)                    │
│  5. Gateway B validates JWT against shared JWKS (same keys!)                 │
│  6. Gateway B returns remoteData                                             │
│  7. Gateway A stitches responses, returns to client                          │
│                                                                              │
│  PROVIDES:                          DOES NOT PROVIDE:                        │
│  ✓ Cross-gateway federation         ✗ Org isolation (shared keys)            │
│  ✓ Token passthrough                ✗ Encrypted transport beyond TLS         │
│  ✓ Combined schema                  ✗ Network isolation                      │
│  ✓ Simple trust model               ✗ Fine-grained peer auth                 │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

```mermaid
flowchart TB
    Client[CLIENT]

    subgraph GWA["GATEWAY A (port 4000)"]
        direction TB
        YogaA["GraphQL Yoga + Stitching"]
        subgraph PeerA["Peer Federation"]
            PeerConfigA["Peer: gateway-b<br/>endpoint: :4001<br/>trust: internal"]
        end
        subgraph AuthA["Auth Layer"]
            JWKSA["SHARED JWKS<br/>./shared/jwks.json"]
        end
        subgraph ChannelsA["Local Channels"]
            SvcA["Svc A"]
            SvcB["Svc B"]
        end
        YogaA --> PeerA
        YogaA --> AuthA
        YogaA --> ChannelsA
    end

    subgraph GWB["GATEWAY B (port 4001)"]
        direction TB
        YogaB["GraphQL Yoga + Stitching"]
        subgraph PeerB["Peer Federation"]
            PeerConfigB["Peer: gateway-a<br/>endpoint: :4000<br/>trust: internal"]
        end
        subgraph AuthB["Auth Layer"]
            JWKSB["SHARED JWKS<br/>./shared/jwks.json"]
        end
        subgraph ChannelsB["Local Channels"]
            SvcC["Svc C"]
            SvcD["Svc D"]
        end
        YogaB --> PeerB
        YogaB --> AuthB
        YogaB --> ChannelsB
    end

    Client -->|"HTTPS + JWT"| YogaA
    PeerConfigA <-->|"HTTPS Token Passthrough"| PeerConfigB
```

### Two Gateways - External Trust (Milestone 2 (M2))

```
┌──────────────────────────────────────────────────────────────────────────────┐
│               STAGE 1C: TWO GATEWAYS - EXTERNAL TRUST (M2)                   │
│                                                                              │
│    ORGANIZATION A                              ORGANIZATION B                │
│    ══════════════                              ══════════════                │
│                                                                              │
│  ┌───────────────────────────────┐        ┌───────────────────────────────┐  │
│  │         GATEWAY A             │        │         GATEWAY B             │  │
│  │         (Org A)               │        │         (Org B)               │  │
│  │                               │        │                               │  │
│  │  ┌─────────────────────────┐  │        │  ┌─────────────────────────┐  │  │
│  │  │       Identity          │  │        │  │       Identity          │  │  │
│  │  │  ┌───────────────────┐  │  │        │  │  ┌───────────────────┐  │  │  │
│  │  │  │ Private Key (A)   │  │  │        │  │  │ Private Key (B)   │  │  │  │
│  │  │  │ Public JWKS (A)   │  │  │        │  │  │ Public JWKS (B)   │  │  │  │
│  │  │  └───────────────────┘  │  │        │  │  └───────────────────┘  │  │  │
│  │  │                         │  │        │  │                         │  │  │
│  │  │  Serves:                │  │        │  │  Serves:                │  │  │
│  │  │  /.well-known/jwks.json │  │        │  │  /.well-known/jwks.json │  │  │
│  │  └─────────────────────────┘  │        │  └─────────────────────────┘  │  │
│  │              │                │        │              │                │  │
│  │  ┌───────────┴─────────────┐  │        │  ┌───────────┴─────────────┐  │  │
│  │  │     Trusted Peers       │  │        │  │     Trusted Peers       │  │  │
│  │  │  ┌───────────────────┐  │  │        │  │  ┌───────────────────┐  │  │  │
│  │  │  │ Peer: org-b-gw    │  │  │        │  │  │ Peer: org-a-gw    │  │  │  │
│  │  │  │ jwksUrl: B's JWKS │◄─┼──┼────────┼──┼─►│ jwksUrl: A's JWKS │  │  │  │
│  │  │  │ trust: external   │  │  │ Fetch  │  │  │ trust: external   │  │  │  │
│  │  │  └───────────────────┘  │  │ JWKS   │  │  └───────────────────┘  │  │  │
│  │  └─────────────────────────┘  │        │  └─────────────────────────┘  │  │
│  │              │                │        │              │                │  │
│  │  ┌───────────┴─────────────┐  │        │  ┌───────────┴─────────────┐  │  │
│  │  │     Token Exchange      │  │        │  │     Token Validation    │  │  │
│  │  │                         │  │        │  │                         │  │  │
│  │  │  1. Receive user token  │  │        │  │  1. Receive cross-org   │  │  │
│  │  │  2. Validate vs A JWKS  │  │        │  │     token from A        │  │  │
│  │  │  3. Mint NEW token:     │──┼────────┼──│  2. Validate vs A JWKS  │  │  │
│  │  │     - Signed by A       │  │ Cross  │  │     (fetched/cached)    │  │  │
│  │  │     - Audience: org-b   │  │  Org   │  │  3. Extract claims      │  │  │
│  │  │     - Delegated claims  │  │ Token  │  │  4. Execute query       │  │  │
│  │  │  4. Send to Gateway B   │  │        │  │                         │  │  │
│  │  └─────────────────────────┘  │        │  └─────────────────────────┘  │  │
│  │                               │        │                               │  │
│  └───────────────────────────────┘        └───────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  TOKEN EXCHANGE FLOW                                                   │  │
│  │                                                                        │  │
│  │  ┌─────────┐      ┌─────────────┐      ┌─────────────┐    ┌─────────┐  │  │
│  │  │  User   │      │  Gateway A  │      │  Gateway B  │    │ Service │  │  │
│  │  └────┬────┘      └──────┬──────┘      └──────┬──────┘    └────┬────┘  │  │
│  │       │                  │                    │                │       │  │
│  │       │ 1. Query +       │                    │                │       │  │
│  │       │    User Token    │                    │                │       │  │
│  │       │─────────────────►│                    │                │       │  │
│  │       │                  │                    │                │       │  │
│  │       │                  │ 2. Validate token  │                │       │  │
│  │       │                  │    vs Org A JWKS   │                │       │  │
│  │       │                  │                    │                │       │  │
│  │       │                  │ 3. Mint cross-org  │                │       │  │
│  │       │                  │    token (signed   │                │       │  │
│  │       │                  │    by Org A key)   │                │       │  │
│  │       │                  │                    │                │       │  │
│  │       │                  │ 4. Forward query + │                │       │  │
│  │       │                  │    cross-org token │                │       │  │
│  │       │                  │───────────────────►│                │       │  │
│  │       │                  │                    │                │       │  │
│  │       │                  │                    │ 5. Fetch Org A │       │  │
│  │       │                  │                    │    JWKS        │       │  │
│  │       │                  │                    │                │       │  │
│  │       │                  │                    │ 6. Validate    │       │  │
│  │       │                  │                    │    cross-org   │       │  │
│  │       │                  │                    │    token       │       │  │
│  │       │                  │                    │                │       │  │
│  │       │                  │                    │ 7. Execute     │       │  │
│  │       │                  │                    │───────────────►│       │  │
│  │       │                  │                    │                │       │  │
│  │       │                  │                    │◄───────────────│       │  │
│  │       │                  │◄───────────────────│ 8. Response    │       │  │
│  │       │◄─────────────────│ 9. Combined        │                │       │  │
│  │       │                  │    response        │                │       │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  CROSS-ORG TOKEN STRUCTURE:                                                  │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  {                                                                     │  │
│  │    "iss": "org-a-gateway",           // Issuer: Org A                  │  │
│  │    "aud": "org-b-gateway",           // Audience: Org B                │  │
│  │    "sub": "user@org-a.com",          // Original user                  │  │
│  │    "iat": 1704067200,                // Issued at                      │  │
│  │    "exp": 1704067500,                // Short expiry (5 min)           │  │
│  │    "delegated_claims": {             // What user can access           │  │
│  │      "channels": ["partner-data"],                                     │  │
│  │      "actions": ["query"]                                              │  │
│  │    }                                                                   │  │
│  │  }                                                                     │  │
│  │  // Signed with Org A's private key                                    │  │
│  │  // Verified with Org A's public JWKS                                  │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  PROVIDES:                          DOES NOT PROVIDE:                        │
│  ✓ Cross-org authentication         ✗ Network-layer encryption               │
│  ✓ Separate key material            ✗ Network isolation                      │
│  ✓ Delegated trust                  ✗ Layer 7 (L7) resilience (retries, etc) │
│  ✓ JWKS federation                  ✗ mutual TLS (mTLS) between all services │
│  ✓ Customer-controlled crypto                                                │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

```mermaid
flowchart TB
    subgraph OrgA["ORGANIZATION A"]
        subgraph GWA["GATEWAY A"]
            direction TB
            subgraph IdA["Identity"]
                PrivKeyA["Private Key (A)<br/>Public JWKS (A)"]
                ServesA["Serves: /.well-known/jwks.json"]
            end
            subgraph TrustA["Trusted Peers"]
                PeerA["Peer: org-b-gw<br/>jwksUrl: B's JWKS<br/>trust: external"]
            end
            subgraph ExchA["Token Exchange"]
                ExchSteps["1. Receive user token<br/>2. Validate vs A's JWKS<br/>3. Mint NEW token<br/>4. Send to Gateway B"]
            end
        end
    end

    subgraph OrgB["ORGANIZATION B"]
        subgraph GWB["GATEWAY B"]
            direction TB
            subgraph IdB["Identity"]
                PrivKeyB["Private Key (B)<br/>Public JWKS (B)"]
                ServesB["Serves: /.well-known/jwks.json"]
            end
            subgraph TrustB["Trusted Peers"]
                PeerB["Peer: org-a-gw<br/>jwksUrl: A's JWKS<br/>trust: external"]
            end
            subgraph ValB["Token Validation"]
                ValSteps["1. Receive cross-org token<br/>2. Validate vs A's JWKS<br/>3. Extract claims<br/>4. Execute query"]
            end
        end
        Service["Service"]
    end

    PeerA <-->|"Fetch JWKS"| PeerB
    ExchA -->|"Cross-Org Token"| ValB
    ValB --> Service
```

```mermaid
sequenceDiagram
    participant User
    participant GatewayA as Gateway A
    participant GatewayB as Gateway B
    participant Service

    User->>GatewayA: 1. Query + User Token
    GatewayA->>GatewayA: 2. Validate token vs Org A JWKS
    GatewayA->>GatewayA: 3. Mint cross-org token (signed by Org A key)
    GatewayA->>GatewayB: 4. Forward query + cross-org token
    GatewayB->>GatewayB: 5. Fetch Org A JWKS (cached)
    GatewayB->>GatewayB: 6. Validate cross-org token
    GatewayB->>Service: 7. Execute
    Service-->>GatewayB: 8. Response
    GatewayB-->>GatewayA: 8. Response
    GatewayA-->>User: 9. Combined response
```

### Offline Policy Enforcement 

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                   OFFLINE POLICY ENFORCEMENT                                 │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                          CONTROL PLANE                                 │  │
│  │                        (when connected)                                │  │
│  │                                                                        │  │
│  │  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐     │  │
│  │  │  Policy Admin   │───►│  Policy Signer  │───►│  Distribution   │     │  │
│  │  │                 │    │  (CP Private    │    │                 │     │  │
│  │  │  - Define rules │    │   Key)          │    │  - Push to GWs  │     │  │
│  │  │  - Set expiry   │    │                 │    │  - Track vers.  │     │  │
│  │  └─────────────────┘    └─────────────────┘    └────────┬────────┘     │  │
│  │                                                         │              │  │
│  └─────────────────────────────────────────────────────────┼──────────────┘  │
│                                                            │                 │
│                            Signed Policy Bundle            │                 │
│                            (when connected)                │                 │
│                                                            ▼                 │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                          GATEWAY NODE                                  │  │
│  │                       (operates 'offline')                             │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐  │  │
│  │  │                       POLICY ENGINE                              │  │  │
│  │  │                                                                  │  │  │
│  │  │  ┌──────────────────┐    ┌────────────────────────────────────┐  │  │  │
│  │  │  │  Policy Cache    │    │  Policy Evaluator                  │  │  │  │
│  │  │  │                  │    │                                    │  │  │  │
│  │  │  │  ┌────────────┐  │    │  For each request:                 │  │  │  │
│  │  │  │  │ Bundle v3  │  │───►│  1. Extract principal              │  │  │  │
│  │  │  │  │ Expires:   │  │    │  2. Extract resource               │  │  │  │
│  │  │  │  │ 2024-01-16 │  │    │  3. Match against policies         │  │  │  │
│  │  │  │  │ Signature: │  │    │  4. Return allow/deny              │  │  │  │
│  │  │  │  │ ✓ Valid    │  │    │                                    │  │  │  │
│  │  │  │  └────────────┘  │    │  NO NETWORK CALL REQUIRED          │  │  │  │
│  │  │  │                  │    │                                    │  │  │  │
│  │  │  └──────────────────┘    └────────────────────────────────────┘  │  │  │
│  │  │                                                                  │  │  │
│  │  │  ┌──────────────────┐    ┌────────────────────────────────────┐  │  │  │
│  │  │  │  CP Public Key   │    │  Background Refresh                │  │  │  │
│  │  │  │                  │    │                                    │  │  │  │
│  │  │  │  Used to verify  │    │  When connected:                   │  │  │  │
│  │  │  │  policy bundle   │    │  - Check for new bundle            │  │  │  │
│  │  │  │  signatures      │    │  - Validate signature              │  │  │  │
│  │  │  │                  │    │  - Atomic swap                     │  │  │  │
│  │  │  └──────────────────┘    └────────────────────────────────────┘  │  │  │
│  │  │                                                                  │  │  │
│  │  └──────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐  │  │
│  │  │                     REQUEST FLOW (OFFLINE)                       │  │  │
│  │  │                                                                  │  │  │
│  │  │  Request ──► JWT Validate ──► Policy Evaluate ──► Execute        │  │  │
│  │  │     │              │                │                │           │  │  │
│  │  │     │              │                │                │           │  │  │
│  │  │     │         Uses cached      Uses cached       Local           │  │  │
│  │  │     │         JWKS             policy bundle     services        │  │  │
│  │  │     │                                                            │  │  │
│  │  │     └─────────────── NO NETWORK CALLS REQUIRED ──────────────────┘  │  │
│  │  │                                                                  │  │  │
│  │  └──────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  POLICY BUNDLE STRUCTURE                                               │  │
│  │                                                                        │  │
│  │  {                                                                     │  │
│  │    "version": "3",                                                     │  │
│  │    "issuedAt": 1704067200,                                             │  │
│  │    "expiresAt": 1704153600,        // 24 hours (Time to Live (TTL))    │  │
│  │    "gracePeriod": 3600,            // 1 hour grace after expiry        │  │
│  │    "issuer": "control-plane-prod",                                     │  │
│  │    "policies": [                                                       │  │
│  │      {                                                                 │  │
│  │        "id": "policy-1",                                               │  │
│  │        "effect": "allow",                                              │  │
│  │        "principals": ["org:acme/*"],                                   │  │
│  │        "resources": ["channel:sales-*", "channel:inventory-*"],        │  │
│  │        "actions": ["query"]                                            │  │
│  │      },                                                                │  │
│  │      {                                                                 │  │
│  │        "id": "policy-2",                                               │  │
│  │        "effect": "deny",                                               │  │
│  │        "principals": ["*"],                                            │  │
│  │        "resources": ["channel:admin-*"],                               │  │
│  │        "actions": ["*"]                                                │  │
│  │      }                                                                 │  │
│  │    ],                                                                  │  │
│  │    "signature": "eyJhbGciOiJFUzM4NCIsInR5cCI6IkpXVCJ9..."              │  │
│  │  }                                                                     │  │
│  │  // Signature covers entire bundle, verified with CP public key        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  OFFLINE OPERATION MODES:                                                    │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │  CONNECTED        DEGRADED           OFFLINE          EXPIRED          │  │
│  │  ─────────        ────────           ───────          ───────          │  │
│  │                                                                        │  │
│  │  Policy sync      Policy stale       Policy cached    Policy           │  │
│  │  active           but valid          and valid        expired          │  │
│  │                                                                        │  │
│  │  Full             Full               Full             Grace period     │  │
│  │  functionality    functionality      functionality    OR reject all    │  │
│  │                                                                        │  │
│  │  ──────────────────────────────────────────────────────────────────►   │  │
│  │                       Connectivity loss duration                       │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  PROVIDES:                            DOES NOT PROVIDE:                      │
│  ✓ Disconnected operation             ✗ Real-time policy updates             │
│  ✓ Cryptographic policy proof         ✗ Fine-grained Attribute-Based Access  │
│                                         Control (ABAC)                       │
│  ✓ Deterministic enforcement          ✗ Cross-org policy sync                │
│  ✓ Grace period handling              ✗ Revocation propagation               │
│  ✓ Control plane independence                                                │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

```mermaid
flowchart TB
    subgraph CP["CONTROL PLANE (when connected)"]
        Admin["Policy Admin<br/>- Define rules<br/>- Set expiry"]
        Signer["Policy Signer<br/>(CP Private Key)"]
        Dist["Distribution<br/>- Push to GWs<br/>- Track versions"]
        Admin --> Signer --> Dist
    end

    subgraph GW["GATEWAY NODE (operates OFFLINE)"]
        subgraph Engine["POLICY ENGINE"]
            subgraph Cache["Policy Cache"]
                Bundle["Bundle v3<br/>Expires: 2024-01-16<br/>Signature: Valid"]
            end
            subgraph Eval["Policy Evaluator"]
                Steps["For each request:<br/>1. Extract principal<br/>2. Extract resource<br/>3. Match against policies<br/>4. Return allow/deny<br/><br/>NO NETWORK CALL REQUIRED"]
            end
            Bundle --> Eval
            CPKey["CP Public Key<br/>Used to verify signatures"]
            Refresh["Background Refresh<br/>When connected:<br/>- Check for new bundle<br/>- Validate signature<br/>- Atomic swap"]
        end

        subgraph Flow["REQUEST FLOW (OFFLINE)"]
            Req["Request"] --> JWTVal["JWT Validate<br/>(cached JWKS)"]
            JWTVal --> PolicyEval["Policy Evaluate<br/>(cached bundle)"]
            PolicyEval --> Exec["Execute<br/>(local services)"]
        end
    end

    Dist -->|"Signed Policy Bundle"| Cache
```

```mermaid
flowchart LR
    subgraph States["OFFLINE OPERATION MODES"]
        direction LR
        Connected["CONNECTED<br/>─────────<br/>Policy sync active<br/>Full functionality"]
        Degraded["DEGRADED<br/>────────<br/>Policy stale but valid<br/>Full functionality"]
        Offline["OFFLINE<br/>───────<br/>Policy cached and valid<br/>Full functionality"]
        Expired["EXPIRED<br/>───────<br/>Policy expired<br/>Grace period OR reject all"]

        Connected --> Degraded --> Offline --> Expired
    end
```

---

## Cross-Deployment Query Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│            FLOW: Client in A queries service in B via GraphQL                │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │  Client (10.1.5.50) in Deployment A                                    │  │
│  │                                                                        │  │
│  │  query {                                                               │  │
│  │    product(sku: "ABC-123") {    ← This service is in Deployment B      │  │
│  │      name                                                              │  │
│  │      stock                                                             │  │
│  │    }                                                                   │  │
│  │  }                                                                     │  │
│  │                                                                        │  │
│  └─────────────────────────────────────┬──────────────────────────────────┘  │
│                                        │                                     │
│                                        │ 1. GraphQL request                  │
│                                        ▼                                     │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │  GraphQL Service (Deployment A)                                        │  │
│  │                                                                        │  │
│  │  2. Query planner sees: product → inventory subgraph                   │  │
│  │  3. Inventory is REMOTE (deploy-b)                                     │  │
│  │  4. Routing mode: GATEWAY (route via B's GraphQL gateway)              │  │
│  │                                                                        │  │
│  └─────────────────────────────────────┬──────────────────────────────────┘  │
│                                        │                                     │
│                                        │ 5. Forward subquery to B's gateway  │
│                                        ▼                                     │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │  Envoy Gateway (Deployment A)                                          │  │
│  │                                                                        │  │
│  │  6. Destination: graphql-b.internal (10.2.0.5)                         │  │
│  │  7. Route lookup: 10.2.0.0/16 → via edge router                        │  │
│  │                                                                        │  │
│  └─────────────────────────────────────┬──────────────────────────────────┘  │
│                                        │                                     │
│                                        │ 8. Packet to 10.2.0.5               │
│                                        ▼                                     │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │  Edge Router (Deployment A)                                            │  │
│  │                                                                        │  │
│  │  9. 10.2.0.0/16 → next-hop        │
│     172.16.2.1 (B's tunnel IP)                                         │  │
│  │  10. Forward via WireGuard interface                                   │  │
│  │                                                                        │  │
│  └─────────────────────────────────────┬──────────────────────────────────┘  │
│                                        │                                     │
│  ════════════════════════════════════════════════════════════════════════    │
│               ENCRYPTED Virtual Private Network (VPN) TUNNEL                 │
│  ════════════════════════════════════════════════════════════════════════    │
│                                        │                                     │
│                                        ▼                                     │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │  Edge Router (Deployment B)                                            │  │
│  │                                                                        │  │
│  │  11. Receive from tunnel, route to 10.2.0.5                            │  │
│  │                                                                        │  │
│  └─────────────────────────────────────┬──────────────────────────────────┘  │
│                                        │                                     │
│                                        ▼                                     │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │  GraphQL Service (Deployment B) - 10.2.0.5                             │  │
│  │                                                                        │  │
│  │  12. Receive subquery: { product(sku: "ABC-123") { name, stock } }     │  │
│  │  13. Route to local inventory service                                  │  │
│  │                                                                        │  │
│  └─────────────────────────────────────┬──────────────────────────────────┘  │
│                                        │                                     │
│                                        ▼                                     │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │  Inventory Service (Deployment B) - 10.2.3.10                          │  │
│  │                                                                        │  │
│  │  14. Execute query, return: { name: "Widget", stock: 42 }              │  │
│  │                                                                        │  │
│  └─────────────────────────────────────┬──────────────────────────────────┘  │
│                                        │                                     │
│                                        │ 15. Response follows reverse path   │
│                                        ▼                                     │
│                                                                              │
│  Total path: Client → Gateway (GW)-A → Envoy-A → Router-A → VPN →            │
│              Router-B →                                                      │
│              GW-B → Inventory → (reverse)                                    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

```mermaid
flowchart TB
    subgraph A["Deployment A"]
        Client["Client (10.1.5.50)<br/>query { product(sku: 'ABC-123') { name, stock } }"]
        GQL_A["GraphQL Service<br/>Query planner sees: product → inventory subgraph<br/>Inventory is REMOTE (deploy-b)<br/>Routing mode: GATEWAY"]
        Envoy_A["Envoy Gateway<br/>Destination: graphql-b.internal (10.2.0.5)<br/>Route lookup: 10.2.0.0/16 → via edge router"]
        Router_A["Edge Router<br/>10.2.0.0/16 → next-hop 172.16.2.1<br/>Forward via WireGuard interface"]
    end

    subgraph VPN["ENCRYPTED VPN TUNNEL"]
        Tunnel[" "]
    end

    subgraph B["Deployment B"]
        Router_B["Edge Router<br/>Receive from tunnel, route to 10.2.0.5"]
        GQL_B["GraphQL Service (10.2.0.5)<br/>Receive subquery, route to local inventory"]
        Inventory["Inventory Service (10.2.3.10)<br/>Execute query, return: { name: 'Widget', stock: 42 }"]
    end

    Client -->|"1. GraphQL request"| GQL_A
    GQL_A -->|"5. Forward subquery to B's gateway"| Envoy_A
    Envoy_A -->|"8. Packet to 10.2.0.5"| Router_A
    Router_A -->|"10. Forward via WireGuard"| Tunnel
    Tunnel --> Router_B
    Router_B -->|"11. Route to 10.2.0.5"| GQL_B
    GQL_B -->|"13. Route to local inventory"| Inventory
    Inventory -.->|"15. Response follows reverse path"| Client
```
