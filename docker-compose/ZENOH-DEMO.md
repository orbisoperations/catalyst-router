# Zenoh 3-Node Multi-Hop Demo

Demonstrates Catalyst routing Zenoh protocol traffic across a 3-node mesh using TCP passthrough proxying via Envoy.

## Topology

```
radar-publisher
       |
  zenoh-router (:7447)                 <-- Zenoh router with radar topic
       |
 [ Node A ]  orch-a + envoy-proxy-a   <-- Origin: hosts the zenoh-router route
       |
 [ Node B ]  orch-b + envoy-proxy-b   <-- Transit: relays traffic
       |
 [ Node C ]  orch-c + envoy-proxy-c   <-- Consumer: tak-adapter connects here
       |
tak-adapter                            <-- Subscribes to radar tracks via Node C
```

Traffic path: `tak-adapter -> Node C -> Node B -> Node A -> zenoh-router`

Each node runs an orchestrator (control plane) + envoy-service (xDS) + envoy-proxy (data plane). The route is created on Node A and propagated to B and C via BGP-inspired route exchange. Envoy proxies at each hop use TCP passthrough (L4) to forward raw Zenoh protocol bytes.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (with Compose v2)
- [Bun](https://bun.sh/) (for the init script)

## Quick Start

### 1. Start the stack

From the repository root:

```bash
docker compose -f docker-compose/zenoh-3node.compose.yaml up -d --build
```

This starts 14 containers:

- **otel-collector** — OpenTelemetry Collector
- **auth** — shared authentication service
- **zenoh-router** — Eclipse Zenoh router
- **radar-publisher** — publishes simulated radar tracks to Zenoh
- **tak-adapter** — subscribes to radar tracks via the Catalyst mesh
- **orch-a/b/c** — orchestrators (control plane)
- **envoy-svc-a/b/c** — Envoy xDS config services
- **envoy-proxy-a/b/c** — Envoy proxies (data plane)

Wait for all services to be healthy:

```bash
docker compose -f docker-compose/zenoh-3node.compose.yaml ps
```

All services should show `healthy` in the STATUS column before proceeding.

### 2. Initialize peering and routes

```bash
cd docker-compose
bun run zenoh-3node-init.ts
```

The init script will:

1. Wait for all orchestrators to be healthy
2. Extract the system token from the auth service logs
3. Establish BGP peering: A <-> B, B <-> C
4. Create the `zenoh-router` TCP route on Node A
5. Wait for xDS propagation (Envoy listeners ready on all 3 nodes)

You should see output like:

```
============================================================
  Zenoh 3-Node Demo — Initialization
============================================================

[...] Step 1/5: Waiting for orchestrators to be healthy...
[...] node-a healthy
[...] node-b healthy
[...] node-c healthy
[...] Step 2/5: Getting system token...
[...] System token: eyJhbGciOiJFUzI1Ni...
[...] Step 3/5: Establishing BGP peering (A <-> B, B <-> C)...
[...] Step 4/5: Creating Zenoh TCP route on Node A...
[...] Step 5/5: Waiting for Envoy xDS propagation across all nodes...

============================================================
  Initialization Complete
============================================================
```

### 3. Verify the data flow

Watch the TAK adapter logs to see radar tracks arriving through the mesh:

```bash
docker compose -f docker-compose/zenoh-3node.compose.yaml logs tak-adapter --follow
```

You should see radar track messages being received — these have traveled through the full multi-hop path: `zenoh-router -> Node A -> Node B -> Node C -> tak-adapter`.

### 4. Inspect Envoy state

Check that Envoy listeners and clusters are configured at each hop:

```bash
# Node A — should have ingress_zenoh-router listener
curl -s http://localhost:9901/listeners?format=json | jq .

# Node B — should have egress_zenoh-router_via_node-a.somebiz.local.io listener
curl -s http://localhost:9902/listeners?format=json | jq .

# Node C — should have egress_zenoh-router_via_node-b.somebiz.local.io listener
curl -s http://localhost:9903/listeners?format=json | jq .
```

### 5. Teardown

```bash
docker compose -f docker-compose/zenoh-3node.compose.yaml down
```

## How It Works

### BGP-Inspired Route Exchange

When the init script creates the `zenoh-router` route on Node A, the orchestrator:

1. **Node A** registers the route locally and broadcasts it to its BGP peer (Node B)
2. **Node B** receives the route update, installs an egress listener, and re-broadcasts to its peer (Node C) with the node path `[node-b, node-a]`
3. **Node C** receives the route update and installs an egress listener pointing at Node B's proxy

This is the same route propagation mechanism used for HTTP/GraphQL services, but with `protocol: tcp` the Envoy listeners use `tcp_proxy` (L4 passthrough) instead of HTTP Connection Manager.

### TCP Passthrough

Because Zenoh uses its own wire protocol (not HTTP), the route is configured with `protocol: tcp`. This tells the Envoy xDS service to generate TCP proxy filter chains instead of HTTP filter chains. The Envoy proxies forward raw bytes at L4, meaning any protocol that runs over TCP works transparently — Zenoh, MQTT, custom binary protocols, etc.

### Multi-Hop Routing

The traffic path through the mesh:

```
tak-adapter
    -> envoy-proxy-c :10000  (tcp_proxy -> envoy-proxy-b:10000)
    -> envoy-proxy-b :10000  (tcp_proxy -> envoy-proxy-a:10000)
    -> envoy-proxy-a :10000  (tcp_proxy -> zenoh-router:7447)
    -> zenoh-router
```

Each hop's Envoy proxy has a listener and upstream cluster configured by its local xDS service. Port allocation and cluster addresses are managed automatically by the orchestrators during route propagation.

## Troubleshooting

**Init script fails with "Could not find system token":**
The auth service may not have started yet. Check its logs:

```bash
docker compose -f docker-compose/zenoh-3node.compose.yaml logs auth
```

**Peering times out:**
Check orchestrator logs for connection errors:

```bash
docker compose -f docker-compose/zenoh-3node.compose.yaml logs orch-a orch-b orch-c
```

**No data in tak-adapter:**

1. Verify the zenoh-router is running: `docker compose -f docker-compose/zenoh-3node.compose.yaml logs zenoh-router`
2. Verify the publisher is sending data: `docker compose -f docker-compose/zenoh-3node.compose.yaml logs radar-publisher`
3. Check Envoy proxy logs for connection errors: `docker compose -f docker-compose/zenoh-3node.compose.yaml logs envoy-proxy-a envoy-proxy-b envoy-proxy-c`

**Envoy listeners not appearing:**
Check the envoy-svc xDS services:

```bash
docker compose -f docker-compose/zenoh-3node.compose.yaml logs envoy-svc-a envoy-svc-b envoy-svc-c
```
