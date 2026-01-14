# Catalyst Node

**Catalyst Node** is a distributed control and data plane designed to bridge organizations, clouds, and disparate fabrics. It enables different organizations to "peer" and offer services to each other in a cloud-native, edge-compatible way.

Modeled after BGP, Catalyst Node brings decentralized routing to Layers 4-7, allowing for service discovery and traffic propagation across trust boundaries without relying on centralized coordination like a single Kubernetes cluster or mesh.

## Mission

Traditional service meshes (like Istio/Linkerd) excel at managing traffic *within* a cluster or organization. Catalyst Node is built for the spaces *between* them. We aim to:

*   **Bridge Disparate Networks**: Connect on-prem datacenters, public clouds, and edge devices (even Raspberry Pis) into a unified service fabric.
*   **Enable Organizational Peering**: Allow Organization A to securely expose specific services to Organization B via standard peering agreements, similar to how ISPs peer on the internet.
*   **Run Anywhere**: Minimal resource footprint, suitable for small compute devices.

## Core Architecture

Catalyst Node runs as a **Core Pod** containing 5 specialized containers:

### 1. Control Plane (The Orchestrator)
The "brain" of the node.
*   **Function**: Handles BGP peering, xDS configuration generation, and sidecar management.
*   **Transport**: Uses `capnweb` RPC to coordinate with sidecars and other nodes.

### 2. Data Plane (Envoy Proxy)
The "muscle" of the node.
*   **Function**: High-performance edge router terminating TLS.
*   **Operation**: Configured dynamically via **xDS** (REST) by the Orchestrator.

### 3. Sidecars (Specialized Functions)
*   **GraphQL Gateway**: TypeScript-based federation engine.
*   **Auth Service**: Handles Key signing and JWKS.
*   **OTEL Collector**: Central metrics sink for the pod.

## Key Features

*   **Decentralized**: No single point of failure or control.
*   **Plugin-Driven**: Extensible architecture for defining custom behaviors for routing, local services, and propagation.
*   **Local Services**: Easily spin up and advertise local resources (e.g., VPN clients, GraphQL federations) as network services.

## Protocol Support

We support a variety of protocols for service definitions. Currently, **GraphQL** receives first-class support for federation.

| Protocol | Status | Notes |
| :--- | :--- | :--- |
| `tcp` | ✅ Stabilized | Generic TCP tunneling |
| `udp` | ✅ Stabilized | Generic UDP tunneling |
| `http` | 🚧 Beta | Generic HTTP proxying |
| `http:graphql` | ✅ Live | Fully federated GraphQL support |
| `http:gql` | ✅ Live | Alias for `http:graphql` |
| `http:grpc` | 🗓️ Planned | gRPC transcoding and routing |

## Development

### Prerequisites

- [Bun](https://bun.sh/) - JavaScript runtime and package manager
- [Podman](https://podman.io/) - Container runtime (Docker alternative)

### Getting Started

```bash
# Install dependencies
bun install

# Start the example services with Podman Compose
bun run start:m0p2
```

### Testing

This project uses a **hybrid testing approach** due to a [known Bun incompatibility with testcontainers](https://github.com/oven-sh/bun/issues/21342):

| Test Type | Command | Runtime | Description |
|-----------|---------|---------|-------------|
| Unit tests | `bun test` | Bun | Fast unit tests (excludes container tests) |
| Container tests | `bun run test:containers` | Node.js (vitest) | Integration tests using testcontainers |

#### Why Two Runtimes?

Bun has a [stream handling bug](https://github.com/oven-sh/bun/issues/21342) that causes testcontainers to hang indefinitely when starting containers. The workaround is to run container tests with **vitest** (which uses Node.js) instead of `bun test`.

```bash
# Run all unit tests (fast, uses Bun)
bun test

# Run container integration tests (uses Node.js via vitest)
bun run test:containers

# Force rebuild container images
REBUILD_IMAGES=true bun run test:containers
```

#### Container Test Configuration

Container tests require proper Podman configuration for testcontainers:

```bash
# These are set automatically by the test:containers script
export DOCKER_HOST="unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
export TESTCONTAINERS_RYUK_DISABLED=true  # Required for rootless Podman
```

See [Podman Desktop's testcontainers tutorial](https://podman-desktop.io/tutorial/testcontainers-with-podman) for more details.

### Docker/Podman Build

The Dockerfiles use **monorepo root as build context** to resolve Bun's catalog dependencies:

```bash
# Build from monorepo root (correct)
podman build -t my-service -f packages/myservice/Dockerfile .

# Build individual service via compose
podman-compose -f docker-compose/example.m0p2.compose.yaml up --build
```

This is required because `package.json` files use `catalog:` references that are defined in the root `package.json`.
