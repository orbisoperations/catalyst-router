# Catalyst Router

**Catalyst Router** is a distributed control and data plane designed to bridge organizations, clouds, and disparate fabrics. It enables different organizations to "peer" and offer services to each other in a cloud-native, edge-compatible way.

Modeled after BGP, Catalyst Router brings decentralized routing to Layers 4-7, allowing for service discovery and traffic propagation across trust boundaries without relying on centralized coordination like a single Kubernetes cluster or mesh.

## Mission

Traditional service meshes (like Istio/Linkerd) excel at managing traffic _within_ a cluster or organization. Catalyst Router is built for the spaces _between_ them. We aim to:

- **Bridge Disparate Networks**: Connect on-prem datacenters, public clouds, and edge devices (even Raspberry Pis) into a unified service fabric.
- **Enable Organizational Peering**: Allow Organization A to securely expose specific services to Organization B via standard peering agreements, similar to how ISPs peer on the internet.
- **Run Anywhere**: Minimal resource footprint, suitable for small compute devices.

## Core Architecture

Catalyst Router runs as a **Core Pod** containing 5 specialized containers:

### 1. Control Plane (The Orchestrator)

The "brain" of the node.

- **Function**: Handles BGP peering, xDS configuration generation, and sidecar management.
- **Transport**: Uses `capnweb` RPC to coordinate with sidecars and other nodes.

### 2. Data Plane (Envoy Proxy)

The "muscle" of the node.

- **Function**: High-performance edge router terminating TLS.
- **Operation**: Configured dynamically via **xDS** (REST) by the Orchestrator.

### 3. Sidecars (Specialized Functions)

- **GraphQL Gateway**: TypeScript-based federation engine.
- **Auth Service**: Handles Key signing and JWKS.
- **OTEL Collector**: Central metrics sink for the pod.

## Key Features

- **Decentralized**: No single point of failure or control.
- **Plugin-Driven**: Extensible architecture for defining custom behaviors for routing, local services, and propagation.
- **Local Services**: Easily spin up and advertise local resources (e.g., VPN clients, GraphQL federations) as network services.

## Protocol Support

We support a variety of protocols for service definitions. Currently, **GraphQL** receives first-class support for federation.

| Protocol       | Status        | Notes                           |
| :------------- | :------------ | :------------------------------ |
| `tcp`          | ✅ Stabilized | Generic TCP tunneling           |
| `udp`          | ✅ Stabilized | Generic UDP tunneling           |
| `http`         | 🚧 Beta       | Generic HTTP proxying           |
| `http:graphql` | ✅ Live       | Fully federated GraphQL support |
| `http:gql`     | ✅ Live       | Alias for `http:graphql`        |
| `http:grpc`    | 🗓️ Planned    | gRPC transcoding and routing    |

## Testing

Catalyst Router employs a multi-tiered testing strategy to ensure reliability across its distributed components. We primarily use `vitest` as our test runner for its speed and native TypeScript support.

### Test Categories

#### 1. Unit Tests

Low-level tests for individual modules and logic. These are fast and have no external dependencies.

```bash
# Run all unit tests in the repository
pnpm run test:unit
```

#### 2. Local Topology Tests

Simulate multi-node orchestration using mocks. These validate routing and synchronization logic WITHOUT needing a container runtime.

```bash
# Example: Run topology tests for the orchestrator
pnpm exec vitest apps/orchestrator/src/next/*.topology.test.ts
```

#### 3. Container Integration Tests

End-to-end tests that spin up actual node containers using Docker and `testcontainers`. These are used for validating network-level handshakes and gateway synchronization.

```bash
# Run container-based integration tests
pnpm run test:container
```

### Docker Environment Setup

Container-based tests are disabled by default to prevent environment-related failures. To enable them, you must have a working Docker installation and set the following environment variable:

```bash
export CATALYST_CONTAINER_TESTS_ENABLED=true
```

> [!TIP]
> You can add `export CATALYST_CONTAINER_TESTS_ENABLED=true` to your shell profile (~/.zshrc or ~/.bashrc) if you frequently run integration tests.

### Running Tests by Package

Apps live in `apps/` and libraries in `packages/`. You can run tests individually:

```bash
cd apps/auth && pnpm test
cd apps/orchestrator && pnpm test
```
