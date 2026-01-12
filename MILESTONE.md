# Catalyst Node Implementation Milestones

This document outlines the step-by-step implementation strategy for **Catalyst Node**, consolidated from the architectural vision and the roll-out strategy.

> **Note on Configuration**: For all phases below, configuration is considered **a priori** (static at startup). We must verify that the node can be fully configured via both **JSON config file** and **CLI arguments/flags**. Dynamic configuration is out of scope for these initial phases.

## Feature Crosswalk (Legacy vs New)

This table maps legacy `catalyst` capabilities to the specific Milestone that delivers them in `catalyst-node`.

| Legacy Capability | New Objective | Fulfillment Milestone |
| :--- | :--- | :--- |
| **Organization** | **Organization** (Root Tenant) | **Milestone 0** (Single Gateway) |
| **Data Channel** | **Service in Mesh** | **Milestone 0** (Local) |
| **Token Minting** | **Identity / Token Issue** | **Milestone 1** (Identity) |
| **Internal Routing** | **Internal Peering** | **Milestone 2** (Internal Trust) |
| **Partnership** | **External Peering** | **Milestone 3** (External Trust) |
| **Traffic Mgmt** | **Advanced Proxy / mTLS** | **Milestone 4** (Envoy Data Plane) |

---

# Milestone 0: Single Gateway

**Goal**: A standalone GraphQL Gateway capable of federating local services, managed by an Orchestrator. No Envoy, no complex Auth, no Peering.

## Subphase 1: GraphQL Gateway (RPC Config)
**Goal**: A standalone GraphQL Gateway container that can be configured via RPC.
### Implementation Goals
*   **Container**: TypeScript container running GraphQL Yoga.
*   **RPC Server**: Implement RPC mechanism to receive configuration (schemas, services).
*   **Config Loop**: Gateway applies config changes without restart.

## Subphase 2: Orchestrator (RPC for GraphQL)
**Goal**: The control plane (Orchestrator) manages the GraphQL Gateway.
### Implementation Goals
*   **Orchestrator**: Node.js process acting as the control plane.
*   **RPC Client**: Connects to the GraphQL Gateway sidecar.
*   **Config Loading**: Load identifying config (ports, etc) and push to Gateway.

## Subphase 3: Example GraphQL Services
**Goal**: Verify federation with actual services.
### Implementation Goals
*   **Service A & B**: Two simple GraphQL services (e.g., Products, Reviews).
*   **Registration**: Services register with the Orchestrator (or are statically defined in Orchestrator config for M0).

## Subphase 4: Client Connection (End-to-End)
**Goal**: Full verification of the request path.
### Implementation Goals
*   **Path**: Client -> GraphQL Gateway -> Service A/B.
*   **Verification**: Query succeeds.

### Architecture Reference (Stage 1A: Milestone 0)
```
┌──────────────────────────────────────────────────────────────────────────────┐
│                 STAGE 1A: CORE POD ARCHITECTURE (Milestone 0)                │
│                                                                              │
│                                                   ┌─────────────────┐        │
│                                                   │     CLIENT      │        │
│                                                   └────────┬────────┘        │
│                                                            │ HTTPS           │
│  ┌─────────────────────────────────────────────────────────┼──────────────┐  │
│  │                           CATALYST CORE POD             ▼              │  │
│  │                                                                        │  │
│  │   ┌─────────────┐                                                      │  │
│  │   │ Orchestrator│                                                      │  │
│  │   │ (Node.js)   │                                                      │  │
│  │   └──────┬──────┘                                                      │  │
│  │          │                                                             │  │
│  │          │RPC                                                          │  │
│  │          ├───(Config)─────┐                                            │  │
│  │          ▼                ▼                                            │  │
│  │                        ┌─────────────┐                                 │  │
│  │                        │ GraphQL GW  │                                 │  │
│  │                        │ (Http)      │                                 │  │
│  │                        └──────┬─┬────┘                                 │  │
│  │                               │ │ Federation                           │  │
│  │                   ┌───────────┘ └─────────┐                            │  │
│  │                   ▼                       ▼                            │  │
│  │            ┌─────────────┐         ┌─────────────┐                     │  │
│  │            │ Example Svc │         │ Example Svc │                     │  │
│  │            │      A      │         │      B      │                     │  │
│  │            └─────────────┘         └─────────────┘                     │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  PROVIDES:                            DOES NOT PROVIDE:                      │
│  ✓ Containerized Isolation            ✗ Sidecar Proxy (Envoy)                │
│  ✓ GraphQL Federation                 ✗ Auth / Identity                      │
│  ✓ Polyglot Sidecars                  ✗ Peering                              │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

# Milestone 1: Identity (Auth Core)

**Goal**: Integrate the **Auth Service** to support Identity issuance and verification. No Envoy yet—Orchestrator manages signature requests directly.

## Subphase 1: Auth Service (Sidecar)
**Goal**: A standalone service capable of signing and verifying JWTs.
### Implementation Goals
*   **Container**: TypeScript container (or Rust/Go if needed later, TS for now).
*   **Key Management**: Generate/Load ECDSA keys (ES384).
*   **RPC Server**: Expose methods to `Sign(payload)` and `Verify(token)`.

## Subphase 2: Orchestrator Integration
**Goal**: Orchestrator uses Auth Service to issue tokens.
### Implementation Goals
*   **RPC Client**: Orchestrator connects to Auth Service.
*   **CLI**: `catalyst service-token` command generates a signed JWT via the Auth Service.
*   **Gateway**: Gateway can be configured to validate Authorization headers using the local Public Key (passed via Config).

### Architecture Reference (Stage 1B: Milestone 1)
Adds the `Auth Service` sidecar to the Core Pod.

---

# Milestone 2: Internal Peering (HTTP)

**Goal**: Connect two nodes from the **same Organization** to share services. This establishes the "Data Channel" parity.

## Subphase 1: Orchestrator Peering (RPC)
**Goal**: Orchestrators discover and exchange routes.
### Implementation Goals
*   **Peering RPC**: Node A connects to Node B.
*   **Route Exchange**: Share routes with `protocol: "graphql-http"`.
*   **Registry**: Orchestrator A registers "Remote Service B" into its Gateway config with a remote URL (`http://node-b-gateway/graphql`).

## Subphase 2: Direct Gateway Federation
**Goal**: Query federation across nodes.
### Implementation Goals
*   **Path**: Client -> Gateway A -> (Federation HTTP) -> Gateway B.
*   **Auth**: Gateway A includes an "Internal Trust" token (signed by shared key) in the request to B. (Since it's Internal Peering, they share the Root Trust).

---

# Milestone 3: External Peering (HTTP)

**Goal**: Connect two nodes from **different Organizations** (Partnership).

## Subphase 1: External Route Exchange
**Goal**: Exchange "Public" routes only.
### Implementation Goals
*   **Policy**: Mark services as `export: true/false`.
*   **Exchange**: Only send exported routes to External Peers.

## Subphase 2: Peer JWKS Trust
**Goal**: Authenticate requests from an external partner.
### Implementation Goals
*   **JWKS Discovery**: Node A fetches Node B's public JWKS.
*   **Validation**: Gateway A attaches a token signed by A. Gateway B validates it using A's JWKS (fetched).
*   **Path**: Client (token A) -> Gateway A -> (Federated with token A) -> Gateway B (Validates token A via A's JWKS).

---

# Milestone 4: Data Plane (Envoy)

**Goal**: **Upgrade** the networking layer by introducing Envoy as the universal ingest/egress proxy.

## Subphase 1: xDS & Envoy Boot
**Goal**: Orchestrator configures Envoy.
### Implementation Goals
*   **xDS Server**: Orchestrator serves LDS/CDS/RDS.
*   **Envoy**: Starts and connects to Orchestrator.

## Subphase 2: Traffic Migration
**Goal**: Move traffic from direct Gateway ports to Envoy ports.
### Implementation Goals
*   **Ingress**: Client -> Envoy (Port 80) -> Gateway (Port 4000).
*   **Egress**: Gateway -> Envoy (Egress Listener) -> Peer.
*   **Result**: All inter-node traffic now flows over TCP/HTTP managed by Envoy.

## Subphase 3: mTLS Preparation
**Goal**: Use Envoy for transport security.
*   Future capability enabled by having Envoy in the path.

---

# Milestone 5: Observability & Policy

*   **Metrics**: OTEL collector, Prometheus scraping.
*   **Advanced Policy**: OPA/Rego or internal policy engine.
*   **Offline Mode**: Durable policy bundles.
