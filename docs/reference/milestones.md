# Catalyst Router Implementation Milestones

This document outlines the step-by-step implementation strategy for **Catalyst Router**, consolidated from the architectural vision and the roll-out strategy.

> **Last reviewed**: 2026-03-05. Updated to reflect completed milestones and v2 routing system.

> **Note on Configuration**: For all phases below, configuration is considered **a priori** (static at startup). We must verify that the node can be fully configured via both **JSON config file** and **CLI arguments/flags**. Dynamic configuration is out of scope for these initial phases.

## Status Overview

| Milestone | Name                    | Status         |
| --------- | ----------------------- | -------------- |
| M0        | Single Gateway          | **Done**       |
| M1        | Identity (Auth Core)    | **Done**       |
| M2        | Internal Peering (iBGP) | **Done**       |
| M3        | External Peering (eBGP) | Planned        |
| M4        | Data Plane (Envoy)      | In progress    |
| M5        | Observability & Policy  | Partially done |

## Feature Crosswalk (Legacy vs New)

This table maps legacy `catalyst` capabilities to the specific Milestone that delivers them in `catalyst-router`. See [crosswalk.md](./crosswalk.md) for the full detailed mapping.

| Legacy Capability    | New Objective                  | Fulfillment Milestone     | Status      |
| :------------------- | :----------------------------- | :------------------------ | :---------- |
| **Organization**     | **Organization** (Root Tenant) | **M0** (Single Gateway)   | Done        |
| **Data Channel**     | **Service in Mesh**            | **M0** (Local)            | Done        |
| **Token Minting**    | **Identity / Token Issue**     | **M1** (Identity)         | Done        |
| **Internal Routing** | **Internal Peering (iBGP)**    | **M2** (Internal Trust)   | Done        |
| **Partnership**      | **External Peering (eBGP)**    | **M3** (External Trust)   | Planned     |
| **Traffic Mgmt**     | **Advanced Proxy / mTLS**      | **M4** (Envoy Data Plane) | In progress |

---

# Milestone 0: Single Gateway — Done

**Goal**: A standalone GraphQL Gateway capable of federating local services, managed by an Orchestrator. No Envoy, no complex Auth, no Peering.

## Subphase 1: GraphQL Gateway (RPC Config)

**Goal**: A standalone GraphQL Gateway container that can be configured via RPC.

### Implementation Goals

- **Container**: TypeScript container running GraphQL Yoga.
- **RPC Server**: Implement RPC mechanism to receive configuration (schemas, services).
- **Config Loop**: Gateway applies config changes without restart.

## Subphase 2: Orchestrator (RPC for GraphQL)

**Goal**: The control plane (Orchestrator) manages the GraphQL Gateway.

### Implementation Goals

- **Orchestrator**: Node.js process acting as the control plane.
- **RPC Client**: Connects to the GraphQL Gateway sidecar.
- **Config Loading**: Load identifying config (ports, etc) and push to Gateway.

## Subphase 3: Example GraphQL Services

**Goal**: Verify federation with actual services.

### Implementation Goals

- **Service A & B**: Two simple GraphQL services (e.g., Products, Reviews).
- **Registration**: Services register with the Orchestrator (or are statically defined in Orchestrator config for M0).

## Subphase 4: Client Connection (End-to-End)

**Goal**: Full verification of the request path.

### Implementation Goals

- **Path**: Client -> GraphQL Gateway -> Service A/B.
- **Verification**: Query succeeds.

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

# Milestone 1: Identity (Auth Core) — Done

**Goal**: Integrate the **Auth Service** to support Identity issuance and verification. No Envoy yet—Orchestrator manages signature requests directly.

### What was built

- **Auth Service** (`apps/auth`): Standalone sidecar with ECDSA key management (ES384), JWT issuance/verification via RPC.
- **Authorization Package** (`packages/authorization`): Cedar policy engine, JWT token manager, key manager with rotation.
- **Certificate-bound access tokens** (ADR-0007): JWTs bound to client TLS certificates for iBGP session auth.
- **CLI integration** (`apps/cli`): `catalyst service-token` command generates signed JWTs via the Auth Service.

---

# Milestone 2: Internal Peering (iBGP) — Done

**Goal**: Connect two nodes from the **same Organization** to share services. This establishes the "Data Channel" parity.

### What was built

The v2 routing system (`packages/routing` + `apps/orchestrator`) implements BGP-inspired iBGP:

- **RIB** (Routing Information Base): Pure-function `plan()`/`commit()` state machine. All state transitions are deterministic and testable.
- **OrchestratorBus**: Wires RIB dispatch to journal, post-commit hooks, and peer transport.
- **Cap'n Proto RPC**: `PublicApi` (service registration) and `IBGPClient` (peer-to-peer route exchange) interfaces over WebSocket.
- **Path-vector loop detection**: Routes carry `nodePath` — reject if local `nodeId` is already in the path.
- **Best-path selection**: Shortest `nodePath` wins.
- **Hold timer keepalive**: Peers negotiate `holdTime = min(local, remote)`. `Tick` actions expire stale peers.
- **Graceful restart**: `TRANSPORT_ERROR` marks routes `isStale` instead of removing, allowing reconnection.
- **Journal replay**: `InMemoryActionLog` (tests) and `SqliteActionLog` (production) for durable action replay.
- **232 tests** across 18 files. See [Test Catalog](./test-catalog.md).

---

# Milestone 3: External Peering (eBGP) — Planned

**Goal**: Connect two nodes from **different Organizations** (Partnership).

## Subphase 1: External Route Exchange

**Goal**: Exchange "Public" routes only.

### Implementation Goals

- **Policy**: Mark services as `export: true/false`.
- **Exchange**: Only send exported routes to External Peers.
- The `RoutePolicy` interface in `@catalyst/routing` is the extensibility point.

## Subphase 2: Peer JWKS Trust

**Goal**: Authenticate requests from an external partner.

### Implementation Goals

- **JWKS Discovery**: Node A fetches Node B's public JWKS.
- **Validation**: Gateway A attaches a token signed by A. Gateway B validates it using A's JWKS (fetched).
- **Path**: Client (token A) -> Gateway A -> (Federated with token A) -> Gateway B (Validates token A via A's JWKS).

---

# Milestone 4: Data Plane (Envoy) — In Progress

**Goal**: **Upgrade** the networking layer by introducing Envoy as the universal ingest/egress proxy.

## Subphase 1: xDS & Envoy Boot — Done

**Goal**: Orchestrator configures Envoy.

### What was built

- **xDS Server** (`apps/envoy`): Orchestrator serves LDS/CDS/RDS to Envoy.
- **PortOperation**: Declarative `allocate`/`release` port ops from the RIB drive Envoy listener configuration.
- **Dynamic port allocation**: Routes carry `envoyPort` for sidecar-managed egress listeners.

## Subphase 2: Traffic Migration — In Progress

**Goal**: Move traffic from direct Gateway ports to Envoy ports.

### Implementation Goals

- **Ingress**: Client -> Envoy (Port 80) -> Gateway (Port 4000).
- **Egress**: Gateway -> Envoy (Egress Listener) -> Peer.
- **Result**: All inter-node traffic now flows over TCP/HTTP managed by Envoy.

## Subphase 3: mTLS Preparation — Planned

**Goal**: Use Envoy for transport security.

- Future capability enabled by having Envoy in the path.

---

# Milestone 5: Observability & Policy — Partially Done

- **Metrics**: OpenTelemetry SDK (`packages/telemetry`) with traces, logs, and metrics. Done.
- **Advanced Policy**: Cedar policy engine (`packages/authorization`). Done.
- **Offline Mode**: Durable policy bundles. Planned.
