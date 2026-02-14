# Zenoh TAK 3-Node Demo

Demonstrates Catalyst mesh TCP passthrough carrying native Zenoh protocol
across a 3-node Envoy mesh, with military TAK (Team Awareness Kit) data.

## Architecture

```
tak-adapter-publisher (emulators: wiesbaden, virginia)
         |
    zenoh-router (:7447)
         |
  [ Node A ] auth-a + orch-a + envoy-proxy-a   (origin)
         |
  [ Node B ] auth-b + orch-b + envoy-proxy-b   (transit relay)
         |
  [ Node C ] auth-c + orch-c + envoy-proxy-c
         |
tak-adapter-consumer (subscribes via TCP passthrough)
         |
    TAK Server (optional)
```

### Network Isolation

Each node runs in its own Docker network (`stack-a`, `stack-b`, `stack-c`).
Only orchestrators and Envoy proxies join the shared `mesh` network for
cross-node communication — matching a real Catalyst deployment where nodes
are network-isolated except for peering and data plane traffic.

### Services (15 containers)

**Node A** (`node-a.somebiz.local.io`) — Origin:

- **auth-a**: Authentication service with Cedar-based authorization (:5050)
- **orch-a**: Orchestrator (:3001)
- **envoy-svc-a**: Envoy xDS control plane (:3010)
- **envoy-proxy-a**: Envoy data plane (:10000, admin :9901)
- **zenoh-router**: Zenoh protocol router (:7447 TCP, :8000 REST)
- **tak-adapter-publisher**: Emulators generating NATO 2525C CoT data

**Node B** (`node-b.somebiz.local.io`) — Transit relay:

- **auth-b**: Authentication service (:5051)
- **orch-b**: Orchestrator (:3002)
- **envoy-svc-b**: Envoy xDS control plane (:3011)
- **envoy-proxy-b**: Envoy data plane (:10001, admin :9902)

**Node C** (`node-c.somebiz.local.io`) — Consumer:

- **auth-c**: Authentication service (:5052)
- **orch-c**: Orchestrator (:3003)
- **envoy-svc-c**: Envoy xDS control plane (:3012)
- **envoy-proxy-c**: Envoy data plane (:10002, admin :9903)
- **tak-adapter-consumer**: Subscribes to CoT data through the mesh

Both TAK adapter services use the same `zeno-tak-adapter-v2` image
(from `examples/zeno-tak-adapter-v2/`) with different configurations:

- **Publisher** (Node A): Runs military unit emulators generating NATO 2525C CoT data
- **Consumer** (Node C): Subscribes to CoT data through the Envoy TCP passthrough mesh

## Prerequisites

- Docker with Compose v2
- Bun (for the init script)
- TLS certificates in this directory: `catalyst.cert.pem`, `catalyst.key.pem`

## Setup Instructions

### Quick Start (automated)

```bash
bash demo/zenoh-tak/init.sh
```

The init script handles the entire bootstrap sequence — starting containers in
order, extracting tokens, minting credentials, and configuring peering. See
below for what it does.

### What the Init Script Does

The init script mirrors a realistic Catalyst deployment bootstrap by starting
containers in phases:

**Phase 1: Auth services**

- Starts auth-a, auth-b, auth-c
- Waits for health checks
- Extracts system admin tokens from each auth service's logs

**Phase 2: Envoy + orchestrators + Zenoh + TAK**

- Starts envoy services and proxies (no auth dependency)
- Starts each orchestrator with its local auth's system token
  (`CATALYST_SYSTEM_TOKEN=<token>` — so it can mint its own NODE token)
- Starts zenoh-router and TAK adapter containers
- Waits for orchestrators to be healthy

**Phase 3: Peer tokens + BGP peering**

- Each auth mints `CATALYST::NODE` tokens for remote peers:
  - auth-a mints token for node-b (so B can authenticate when connecting to A)
  - auth-b mints tokens for node-a and node-c
  - auth-c mints token for node-b (so B can authenticate when connecting to C)
- Establishes BGP peering with peer tokens:
  - A <-> B (bidirectional, each side registers the other with peer token)
  - B <-> C (bidirectional)
  - Waits for peering handshakes to complete (connection status = `connected`)

**Phase 4: Route + xDS propagation**

- Creates Zenoh TCP route on Node A:
  `{ name: 'zenoh-router', protocol: 'tcp', endpoint: 'http://zenoh-router:7447' }`
- Waits for Envoy listeners on all nodes:
  - Node A: `ingress_zenoh-router` (accepts incoming TCP)
  - Node B: `egress_zenoh-router_via_node-a.somebiz.local.io` (forwards to A)
  - Node C: `egress_zenoh-router_via_node-b.somebiz.local.io` (forwards to B)

### Manual Setup (step-by-step)

If you prefer to run the bootstrap manually (or need to debug):

#### 1. Start auth services

```bash
docker compose -f demo/zenoh-tak/docker-compose.yaml up -d --build auth-a auth-b auth-c
```

#### 2. Extract system admin tokens

```bash
docker compose -f demo/zenoh-tak/docker-compose.yaml logs auth-a | grep "System Admin Token"
docker compose -f demo/zenoh-tak/docker-compose.yaml logs auth-b | grep "System Admin Token"
docker compose -f demo/zenoh-tak/docker-compose.yaml logs auth-c | grep "System Admin Token"
```

#### 3. Start orchestrators with system tokens

```bash
CATALYST_SYSTEM_TOKEN="<token-a>" docker compose -f demo/zenoh-tak/docker-compose.yaml up -d orch-a
CATALYST_SYSTEM_TOKEN="<token-b>" docker compose -f demo/zenoh-tak/docker-compose.yaml up -d orch-b
CATALYST_SYSTEM_TOKEN="<token-c>" docker compose -f demo/zenoh-tak/docker-compose.yaml up -d orch-c
```

#### 4. Start remaining services

```bash
docker compose -f demo/zenoh-tak/docker-compose.yaml up -d
```

#### 5. Configure peering and routes

Use the Catalyst CLI to mint peer tokens, establish peering, and create routes.

### Watch the data flow

```bash
# Consumer receiving CoT data through the 3-node mesh
docker compose -f demo/zenoh-tak/docker-compose.yaml logs tak-adapter-consumer --follow

# Publisher generating emulator data
docker compose -f demo/zenoh-tak/docker-compose.yaml logs tak-adapter-publisher --follow
```

## Token-Based Authentication Flow

The init script uses CLI handlers from `@catalyst/cli` — the same code path
as the real Catalyst CLI tool.

1. **Auth service startup**: Each auth service starts and auto-mints a system admin token
   (logged to stdout)
2. **Token extraction**: The init script reads each auth's logs for its system token
3. **Orchestrator startup**: Each orchestrator is started with `CATALYST_SYSTEM_TOKEN`
   set to its local auth's system token. On startup, the orchestrator uses this to mint
   a NODE token for itself (principal: `CATALYST::NODE`, 7-day TTL).
4. **Peer token minting**: The init script calls `mintTokenHandler()` on each auth
   to create `CATALYST::NODE` tokens for remote peers. Each token is scoped to a
   specific node ID and trusted domain.
5. **Peering with tokens**: The init script calls `createPeerHandler()` with the
   peer token — the orchestrator stores the token and presents it when connecting
   to the remote peer for BGP session establishment
6. **Cedar authorization**: Each auth service evaluates Cedar policies for requested
   actions (add peer, create route, etc.)
7. **BGP peering**: Orchestrators exchange route advertisements over WebSocket RPC

## What the Demo Shows

1. **TCP Passthrough**: Native Zenoh TCP protocol (not HTTP) traverses the Envoy mesh
   unmodified. The consumer's internal zenohd connects through:
   `envoy-proxy-c -> envoy-proxy-b -> envoy-proxy-a -> zenoh-router:7447`

2. **BGP Route Propagation**: When the TCP route is created on Node A, it propagates
   automatically through the mesh: A -> B -> C. Each node creates the appropriate
   Envoy listener (ingress or egress) via xDS.

3. **Network Isolation**: Each node runs in its own Docker network. Only orchestrators
   and Envoy proxies share the mesh network — matching real deployment topology.

4. **Per-Node Authentication**: Each node has its own auth server. Peer tokens are
   minted by the target node's auth and presented during BGP session establishment.

5. **Military Data Pipeline**: NATO 2525C CoT (Cursor on Target) events with
   simulated military units (infantry, armor, aircraft, naval vessels) from
   multiple regions (Wiesbaden, Virginia).

## Verify

```bash
# Check Envoy listeners on each node
curl -s http://localhost:9901/listeners?format=json | jq .  # Node A (ingress)
curl -s http://localhost:9902/listeners?format=json | jq .  # Node B (egress via A)
curl -s http://localhost:9903/listeners?format=json | jq .  # Node C (egress via B)

# Check Zenoh router data via REST API
curl -s http://localhost:8000/tak/cot | head

# Check orchestrator health
curl -s http://localhost:3001/health  # Node A
curl -s http://localhost:3002/health  # Node B
curl -s http://localhost:3003/health  # Node C

# Check auth service health
curl -s http://localhost:5050/health  # Node A
curl -s http://localhost:5051/health  # Node B
curl -s http://localhost:5052/health  # Node C
```

## Ports

| Service       | Host Port | Network        | Description             |
| ------------- | --------- | -------------- | ----------------------- |
| auth-a        | 5050      | stack-a        | Auth service Node A     |
| auth-b        | 5051      | stack-b        | Auth service Node B     |
| auth-c        | 5052      | stack-c        | Auth service Node C     |
| orch-a        | 3001      | stack-a + mesh | Orchestrator Node A     |
| orch-b        | 3002      | stack-b + mesh | Orchestrator Node B     |
| orch-c        | 3003      | stack-c + mesh | Orchestrator Node C     |
| envoy-svc-a   | 3010      | stack-a        | Envoy xDS Node A        |
| envoy-svc-b   | 3011      | stack-b        | Envoy xDS Node B        |
| envoy-svc-c   | 3012      | stack-c        | Envoy xDS Node C        |
| envoy-proxy-a | 10000     | stack-a + mesh | Envoy data plane Node A |
| envoy-proxy-b | 10001     | stack-b + mesh | Envoy data plane Node B |
| envoy-proxy-c | 10002     | stack-c + mesh | Envoy data plane Node C |
| envoy-admin-a | 9901      | stack-a + mesh | Envoy admin Node A      |
| envoy-admin-b | 9902      | stack-b + mesh | Envoy admin Node B      |
| envoy-admin-c | 9903      | stack-c + mesh | Envoy admin Node C      |
| zenoh-router  | 7447/8000 | stack-a        | Zenoh TCP/REST          |

## Development Notes

- Auth services auto-mint system admin tokens at startup (logged to stdout)
- Auth services use in-memory databases (`:memory:`) — no persistent volumes needed
- Each auth must be healthy before its orchestrator starts (health check dependency)
- All three orchestrators share `CATALYST_DOMAINS=somebiz.local.io` for peering
- The init script must be run from the repo root (it uses relative paths for docker compose)
- Services are labeled with `catalyst.stack: {a,b,c}` for filtering

## Teardown

```bash
docker compose -f demo/zenoh-tak/docker-compose.yaml down -v
```
