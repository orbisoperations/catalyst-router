# Technology Stack

## Core Runtime
*   **Language**: **TypeScript** (Running on **Node.js**).
    *   *Rationale*: Ubiquity, huge ecosystem, and strong typing for complex routing logic.
*   **Paradigm**: **Functional Programming (FP)**.
    *   *Usage*: The core event loop and state transitions will be modeled as pure functions to ensure predictability and testability.
*   **Concurrency**: Event-driven, non-blocking I/O.


## CLI & Interface
*   **Framework**: **[Commander.js](https://github.com/tj/commander.js)**.
*   **Rationale**: Robust argument parsing, auto-generated help, and standard POSIX-style flags make for a developer-friendly CLI.

## Control Plane (Communications)
*   **RPC / Transport**: **[Capnweb](https://github.com/cloudflare/capnweb)**.
    *   *Technology*: WebSockets + Cap'n Proto.
    *   *Rationale*: Provides high-performance, strongly-typed, continuous connections for real-time state synchronization (heartbeats, route updates) with minimal boilerplate.
    *   *Protocol*: Custom implementation mimicking BGP attribute propagation.

## Data Plane (Traffic)
*   **Proxy Engine**: **[Envoy Proxy](https://github.com/envoyproxy/envoy)**.
    *   *Rationale*: Industry standard for high-performance sidecar/edge proxying.
    *   *Integration*:
        *   **Future**: xDS (gRPC) for dynamic streaming configuration.

## Build, Delivery & Containers
*   **Strategy**: **Docker-First**.
    *   **Rationale**: Simplifies the complex toolchain required for custom OpenSSL/Envoy builds and ensures consistency across macOS (dev) and Linux (prod).
*   **Base Image**: Custom Alpine/Debian image with **OpenSSL (TLS 1.3 + Kyber)**.
*   **Artifacts**:
    *   **Build Container**: Contains Bazel, compilers, and PQC libraries.
    *   **Runtime Container**: Minimal image containing the Node.js Control Plane and the custom Envoy binary.
*   **Architectures**: Multi-arch images (standard `docker buildx` pipeline) for `linux/amd64` and `linux/arm64`.

## Plugin System
An extensible interface allows the core router to be customized. Plugins interact via:
1.  **Route Table Updates**: Reacting to incoming advertisements.
2.  **Local Service Configuration**: Managing local processes (e.g., spawning a WireGuard tunnel or GraphQL server).
3.  **Propagation Events**: Controlling what routes are advertised to peers.
