# Docker Compose Examples

This directory contains Docker Compose configurations for running Catalyst Node in different topologies.
TODO: Need to actually add the telemtry to the services for docker.compose.yaml and two-node.compose.yaml.

| File | Topology | Observability | Auth Model |
| ---- | -------- | ------------- | ---------- |
| `docker.compose.yaml` | Single node | OTEL Collector | Minimal |
| `two-node.compose.yaml` | Two-node peering | OTEL Collector | Shared auth |
| `example.m0p2.compose.yaml` | Single node (M0P2) | None | Full bootstrap flow |

## Single Node (`docker.compose.yaml`)

A single Catalyst node with OpenTelemetry observability. Good for local development and testing.

### Services

- **otel-collector**: OpenTelemetry Collector (OTLP gRPC :4317, HTTP :4318)
- **auth**: Authentication service (:4020)
- **orchestrator**: Control plane orchestrator (:3000)
- **gateway**: GraphQL federation gateway (:4000)
- **books-service**: Example GraphQL service (:8081)
- **movies-service**: Example GraphQL service (:8082)

### Usage

```bash
docker compose -f docker-compose/docker.compose.yaml up --build
```

All services emit traces, metrics, and logs to the OTEL Collector via `OTEL_EXPORTER_OTLP_ENDPOINT`. The collector is configured to export to debug (stdout) — see `otel-collector-config.yaml` to add backends like Jaeger or Prometheus.

## Two-Node Peering (`two-node.compose.yaml`)

Two Catalyst nodes peered on the same domain, each with their own gateway and subgraph service. Demonstrates BGP-inspired service route exchange between nodes.

### Services

**Shared infrastructure:**
- **otel-collector**: OpenTelemetry Collector (OTLP gRPC :4317, HTTP :4318)
- **auth**: Shared authentication service (:4020)

**Node A** (`node-a.somebiz.local.io`):
- **node-a**: Orchestrator (:3001)
- **gateway-a**: Gateway (:4000)
- **books-service**: Books subgraph (:8081)

**Node B** (`node-b.somebiz.local.io`):
- **node-b**: Orchestrator (:3002)
- **gateway-b**: Gateway (:4001)
- **movies-service**: Movies subgraph (:8082)

### Usage

```bash
docker compose -f docker-compose/two-node.compose.yaml up --build
```

Both nodes share `CATALYST_PEERING_SECRET=valid-secret` and `CATALYST_DOMAINS=somebiz.local.io`, so they can establish a peering session and exchange service routes. Node A advertises the books subgraph; Node B advertises the movies subgraph.

## M0P2 Example with Auth Integration (`example.m0p2.compose.yaml`)

Demonstrates the full token-based authentication bootstrap flow. Requires manual token extraction.

### Services

- **auth**: Authentication service handling JWTs, key rotation, and Cedar-based authorization (:5000)
- **orchestrator**: Control plane orchestrator with token-based authentication (:3000)
- **gateway**: GraphQL federation gateway (:4000)
- **books-service**: Example GraphQL service (:8081)
- **movies-service**: Example GraphQL service (:8082)

### Setup Instructions

#### 1. Start the auth service first

```bash
docker compose -f docker-compose/example.m0p2.compose.yaml up auth
```

#### 2. Extract the system admin token

The auth service generates a system admin token on startup and logs it. Watch the logs for:

```
System token: eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Ii4uLiJ9...
```

Copy this token.

#### 3. Set the system token environment variable

```bash
export CATALYST_SYSTEM_TOKEN="<paste token here>"
```

#### 4. Start remaining services

```bash
docker compose -f docker-compose/example.m0p2.compose.yaml up
```

### How It Works

1. **Auth Service Startup**: The auth service starts and mints a system admin token using the bootstrap token
2. **Token Handoff**: The orchestrator receives the system token via `CATALYST_SYSTEM_TOKEN` environment variable
3. **Node Token Minting**: On startup, the orchestrator uses the system token to mint a NODE token for itself
4. **Token Validation**: All incoming requests to the orchestrator are validated via the auth service's permissions API

### Development Notes

- The bootstrap token is set to `dev-bootstrap-token` for development
- Auth data (keys and tokens) is persisted in a Docker volume named `auth-data`
- The auth service must be healthy before the orchestrator starts (health check dependency)

## OpenTelemetry Collector Configuration (`otel-collector-config.yaml`)

Shared collector config used by `docker.compose.yaml` and `two-node.compose.yaml`.

- **Receivers**: OTLP over gRPC (:4317) and HTTP (:4318)
- **Processors**: `memory_limiter` (256 MiB cap, 5s check interval) and `batch`
- **Exporters**: `debug` (detailed stdout)
- **Pipelines**: traces, metrics, and logs all flow through the same receiver/processor/exporter chain

To add production backends, add exporters to this file (e.g., `otlp/jaeger`, `prometheus`). See [ADR-0003](../docs/adr/0003-observability-backends.md) for approved backend choices.

## Token-Based Authentication Flow

1. Caller provides token to `getIBGPClient()`, `getNetworkClient()`, or `getDataChannelClient()`
2. Orchestrator calls auth service `permissions(callerToken)` to validate token
3. Auth service validates token and checks Cedar policies for requested action
4. If authorized, orchestrator returns the requested client
5. Client method calls are dispatched without additional auth checks (already validated)

## Bypassing Auth (Testing Only)

For unit tests, you can bypass auth validation by setting:

```bash
export CATALYST_SKIP_AUTH=true
```

**WARNING**: Never use this in production!
