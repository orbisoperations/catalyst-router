# Catalyst Router

Decentralized L4-7 service routing across trust boundaries

![License](https://img.shields.io/badge/License-ELv2%20%2B%20Commons%20Clause-blue)

## What is Catalyst Router?

Traditional service meshes like Istio and Linkerd manage traffic within a single cluster or organization. Catalyst Router is built for the spaces between them. It is a distributed control and data plane that bridges organizations, clouds, and disparate fabrics, enabling them to "peer" and offer services to each other in a cloud-native, edge-compatible way.

Modeled after BGP, Catalyst Router brings decentralized routing to Layers 4-7. There is no single control plane to operate or negotiate access through. Instead, each node maintains its own routing table and exchanges routes with its peers, just as autonomous systems do on the internet. This makes it a natural fit for platform engineers building multi-organization service meshes, cross-cloud federations, or edge topologies that span heterogeneous infrastructure.

Unlike centralized approaches, Catalyst Router requires no shared Kubernetes cluster, no central registry, and no mutual trust authority beyond pairwise peering agreements. Organizations retain full sovereignty over what they expose, to whom, and under what policy constraints.

## Key Features

- BGP-inspired peer-to-peer route exchange across trust boundaries
- GraphQL federation gateway with schema stitching
- Cedar policy engine for fine-grained authorization
- Principal-based JWT authentication with certificate-bound tokens
- OpenTelemetry-native observability (logs, metrics, traces)
- Docker-native deployment with Core Pod architecture
- SQLite persistence with zero external database dependencies
- Runs on Bun with a minimal resource footprint

## Architecture Overview

Each Catalyst Router node runs as a **Core Pod** -- a set of cooperating containers that together form a complete routing unit:

```mermaid
C4Container
  title Catalyst Router - Core Pod

  Container(orchestrator, "Orchestrator", "TypeScript / Bun", "Control plane: BGP peering, route exchange, sidecar coordination")
  Container(auth, "Auth Service", "TypeScript / Bun", "JWT signing, JWKS endpoint, key management")
  Container(gateway, "Gateway", "TypeScript / Bun", "GraphQL federation, schema stitching, request routing")
  Container(otel, "OTEL Collector", "OpenTelemetry", "Metrics, logs, and traces aggregation")

  Rel(orchestrator, auth, "Issues tokens")
  Rel(orchestrator, gateway, "Pushes schema config")
  Rel(orchestrator, otel, "Emits telemetry")
  Rel(auth, otel, "Emits telemetry")
  Rel(gateway, otel, "Emits telemetry")
  Rel(gateway, auth, "Validates tokens")
```

The Orchestrator is the brain of the pod -- it manages peering sessions, computes routes, and coordinates the Auth and Gateway sidecars. All components emit telemetry to the OTEL Collector.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.1
- [Docker](https://www.docker.com/) (for compose deployments)

### Install

```bash
bun install
```

### Run a single-node example

```bash
docker compose -f docker-compose/example.m0p2.compose.yaml up
```

### Run tests

```bash
bun test
```

## Repository Structure

| Directory                | Package                          | Description                                    |
| :----------------------- | :------------------------------- | :--------------------------------------------- |
| `apps/auth`              | `@catalyst/auth-service`         | JWT signing, JWKS, key management              |
| `apps/cli`               | `@catalyst/cli`                  | Command-line interface for node management     |
| `apps/gateway`           | `@catalyst/gateway-service`      | GraphQL federation gateway                     |
| `apps/node`              | `@catalyst/node-service`         | Composite node entrypoint                      |
| `apps/orchestrator`      | `@catalyst/orchestrator-service` | Control plane: peering, routing, coordination  |
| `packages/authorization` | `@catalyst/authorization`        | Cedar policy engine integration                |
| `packages/config`        | `@catalyst/config`               | Shared configuration schemas and loaders       |
| `packages/routing`       | `@catalyst/routing`              | Route table, path computation, exchange        |
| `packages/sdk`           | `@catalyst/sdk`                  | Client SDK for interacting with Catalyst nodes |
| `packages/service`       | `@catalyst/service`              | Base service class with built-in telemetry     |
| `packages/telemetry`     | `@catalyst/telemetry`            | OpenTelemetry setup and instrumentation        |
| `packages/types`         | `@catalyst/types`                | Shared TypeScript type definitions             |
| `examples/books-api`     | --                               | Example federated subgraph                     |
| `examples/movies-api`    | --                               | Example federated subgraph                     |
| `examples/orders-api`    | --                               | Example federated subgraph                     |
| `examples/product-api`   | --                               | Example federated subgraph                     |

## Documentation

- [Architecture](./ARCHITECTURE.md) -- system design and component interactions
- [Constitution](./constitution.md) -- architectural principles and constraints
- [Security](./SECURITY.md) -- peer security protocol and threat model
- [ADRs](./docs/adr/) -- architecture decision records
- [CLI Reference](./CLI.md) -- command-line usage and options

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines. All contributors must sign the [Contributor License Agreement](./CLA.md).

This project uses [Graphite](https://graphite.dev) for stacked PRs and follows [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

## Security

Catalyst Router uses mTLS for node-to-node communication, JWT with certificate-bound tokens for request authentication, and Cedar policies for fine-grained authorization. See [SECURITY.md](./SECURITY.md) for the full security protocol.

## License

Source-available under the [Commons Clause + Elastic License 2.0](./LICENSE). See [LICENSE_HUMAN_READABLE.md](./LICENSE_HUMAN_READABLE.md) for a plain-language summary.

Licensor: **Orbis Operations LLC**

This software is **not** open source. The Commons Clause restricts commercial use of the software as a hosted or managed service. See the license files for full terms.
