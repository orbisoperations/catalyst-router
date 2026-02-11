# Technology Stack

## Core Runtime

- **Language**: **TypeScript** (Running on **Node.js**).
  - _Rationale_: Ubiquity, huge ecosystem, and strong typing for complex routing logic.
- **Paradigm**: **Functional Programming (FP)**.
  - _Usage_: The core event loop and state transitions will be modeled as pure functions to ensure predictability and testability.
- **Concurrency**: Event-driven, non-blocking I/O.

## CLI & Interface

- **Framework**: **[Commander.js](https://github.com/tj/commander.js)**.
- **Rationale**: Robust argument parsing, auto-generated help, and standard POSIX-style flags make for a developer-friendly CLI.

## Control Plane (Communications)

- **RPC / Transport**: **[Capnweb](https://github.com/cloudflare/capnweb)**.
  - _Technology_: WebSockets + Cap'n Proto.
  - _Rationale_: Provides high-performance, strongly-typed, continuous connections for real-time state synchronization (heartbeats, route updates) with minimal boilerplate.
  - _Protocol_: Custom implementation mimicking BGP attribute propagation.

## Data Plane (Traffic)

- **Proxy Engine**: **[Envoy Proxy](https://github.com/envoyproxy/envoy)**.
  - _Rationale_: Industry standard for high-performance sidecar/edge proxying.
  - _Integration_:
    - **Current**: xDS (REST) for dynamic streaming configuration.

## Build, Delivery & Containers

- **Strategy**: **Core Pod (Docker Compose)**.
  - **Rationale**: Decomposes the monolith into specialized containers (Orchestrator, Gateway, Auth, OTEL).
- **Base Image**: Custom minimal images for each service.
- **Architectures**: Multi-arch images for `linux/amd64` and `linux/arm64`.

## Extension System (Sidecars)

The system is extended via **Sidecar Containers** managed by the Orchestrator via RPC:

1.  **GraphQL Gateway**: Handles federation logic.
2.  **Auth Service**: Handles crypto operations.
3.  **Custom Sidecars**: Users can bring their own containers that register via the SDK.
