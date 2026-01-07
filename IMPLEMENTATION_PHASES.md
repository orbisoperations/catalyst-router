# Implementation Phases

This document outlines the step-by-step implementation strategy for **Catalyst Node**.

> **Note on Configuration**: For all phases below, configuration is considered **a priori** (static at startup). We must verify that the node can be fully configured via both **JSON config file** and **CLI arguments/flags**. Dynamic configuration is out of scope for these initial phases.

## Phase 1: Basic Node & GraphQL Federation
**Goal**: A standalone node running a local GraphQL federation with testable configuration.

```mermaid
graph TD
    User((User)) ==>|HTTP| Envoy[Envoy Data Plane]
    Envoy ==>|Traffic| GQL[GraphQL Gateway]
    GQL -->|Sub-graph| Svc1[Service A]
    GQL -->|Sub-graph| Svc2[Service B]
    Node[Catalyst Node] -.->|Config| Envoy
    Node -.->|Manage| GQL
```

*   **Capabilities**:
    *   **Configuration**: Load settings (ports, service lists) via JSON file OR CLI flags.
    *   Spin up a GraphQL federation server (using Apollo Gateway or similar).
    *   Integrate two local example services (from `packages/sdk` examples).
    *   Run a basic Envoy proxy instance (static config).
*   **Testing**:
    *   **Unit**: Vitest tests in the `node` directory using different config methods.
    *   **Manual**: Documented "Demo Run" where a user can query the federation.
*   **Artifacts**:
    *   `packages/node`: Core server logic.
    *   `packages/sdk`: Example services.
    *   `demo/phase1.md`: Instructions for running the demo.

## Phase 2: Internal Peering (No Auth)
**Goal**: Two nodes exchanging routes for local services within a trusted boundary.

```mermaid
graph LR
    subgraph NodeA [Node A]
        CA[Control Plane<br/>Node.js]
        DA[Data Plane<br/>Envoy Proxy]
        GA[GraphQL Gateway<br/>Apollo]
    end
    subgraph NodeB [Node B]
        CB[Control Plane<br/>Node.js]
        DB[Data Plane<br/>Envoy Proxy]
        SB[Local Service<br/>Service B]
    end
    
    Client[Client] ==>|Query| DA
    
    CA <-->|Peering RPC| CB
    DA ==>|Internal Traffic| DB
    DA --> GA
    GA -.->|Federation| DB
    DB --> SB
```

*   **Capabilities**:
    *   **Configuration**: Define peers and protocol settings via JSON/CLI.
    *   **Peering**: Establish a connection between Node A and Node B.
    *   **Route Exchange**: Share routes with `protocol: "graphql"`.
    *   **Data Plane**:
        *   Each node runs a GraphQL Gateway behind Envoy.
        *   Envoy is configured to route traffic to the peer's Envoy/Service.
    *   **Client**: A GraphQL client on Node A queries the federation, resolving fields served by Node B.
*   **Constraint**: No authentication or encryption on the peering link yet.
*   **Key Concept**: "Internal" route table usage.

## Phase 3: External Peering
**Goal**: Cross-domain service discovery and routing.

```mermaid
graph LR
    subgraph Org1 [Organization 1 / Trusted]
        C1[Client]
        NA[Control Plane<br/>Node.js]
        DA[Data Plane<br/>Envoy Proxy]
        ExtPol[Export Policy]
    end
    subgraph Org2 [Organization 2 / Untrusted]
        NB[Control Plane<br/>Node.js]
        DB[Data Plane<br/>Envoy Proxy]
        Svc[Service]
        ImpPol[Import Policy]
    end
    
    C1 ==>|Query| DA
    NA <-->|"External Peering (Filtered)"| NB
    DA ==>|"Cross-Org Traffic"| DB
    DB --> Svc
    
    NA -.-> ExtPol
    NB -.-> ImpPol
```

*   **Capabilities**:
    *   **Configuration**: Define Export/Import policies via JSON/CLI.
    *   Separate **Internal** (Trusted) vs **External** (Untrusted) Route Tables.
    *   **Export Policies**: Define which internal routes are advertised to external peers.
    *   **Import Policies**: Define how external routes are mapped into the local mesh.
*   **Scenario**: Node A (Org 1) shares a specific service with Node B (Org 2).
*   **Differentiation**: Simulates crossing a trust boundary (internet/cloud implementation).

## Phase 4: Observability & Metrics
**Goal**: Visibility into the control and data planes.

```mermaid
graph TD
    subgraph Node
        CP[Control Plane]
        DP[Envoy]
        SDK[(Service SDK)]
    end
    
    SDK --"Metrics Push"--> CP
    CP -.->|Scrape? / Push?| Upstream[Metrics Store<br/>TBD]
    DP -.->|Scrape| Upstream
```

*   **Capabilities**:
    *   **Configuration**: Configurable metrics endpoints and scraping intervals via JSON/CLI.
    *   **SDK Metrics**: Instrumentation for local services.
    *   **Node Metrics**: Control plane stats (peer count, route updates).
    *   **Envoy Metrics**: Scrape and expose Envoy stats.
*   **Integration**: Prometheus/OpenTelemetry compatible endpoint.

## Phase 5: Authentication (JWT & JWKS)
**Goal**: Secure service-to-service communication.

```mermaid
graph TD
    Client ==>|"JWT Token"| DP[Envoy Ingress]
    DP -->|Validate| Auth[Auth Filter]
    Auth --> Svc[Service]
    JWKS[JWKS Provider] -.->|Key Fetch| DP
```

*   **Capabilities**:
    *   **Configuration**: Define JWKS URLs and Auth policies via JSON/CLI.
    *   **Identity**: Integrate JWT validation in Envoy.
    *   **Key Discovery**: Implement JWKS endpoint or distribution mechanism.
    *   **Topology**: Combine Phase 2 & 3 scenarios with enforced auth.
        *   Internal traffic: Validated.
        *   External traffic: Strict token validation at the ingress.

## Phase 6: Mutual TLS (mTLS)
**Goal**: Encrypted and authenticated transport layer.

```mermaid
graph LR
    subgraph NodeA
        CPA[Control Plane]
        DPA[Envoy]
    end
    subgraph NodeB
        CPB[Control Plane]
        DPB[Envoy]
    end
    
    CPA <-->|mTLS Encrypted| CPB
    DPA ==>|"mTLS Encrypted"| DPB
    CA[PKI / CA] -.-> CPA
    CA -.-> CPB
```

*   **Capabilities**:
    *   **Configuration**: Paths to certs/keys defined via JSON/CLI.
    *   Integrate the PKI/CA solution (defined in RFI).
    *   **Control Plane**: mTLS for Capnweb/RPC connections.
    *   **Data Plane**: mTLS between Envoys.
*   **Validation**: Verify encryption and identity assertion for all hops.
